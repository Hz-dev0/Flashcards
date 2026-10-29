package com.flashcards.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.drawable.Icon;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 連播用的前景服務：整個播放流程（單字 → 備註 → 英文例句 → 中文例句 → 下一張）都在這裡跑，
 * 不依賴網頁，所以螢幕關掉、App 在背景也會繼續唸。
 */
public class SpeechService extends Service {

    static final String ACTION_START = "fc.START";
    static final String ACTION_PAUSE = "fc.PAUSE";
    static final String ACTION_RESUME = "fc.RESUME";
    static final String ACTION_NEXT = "fc.NEXT";
    static final String ACTION_STOP = "fc.STOP";

    private static final String CHANNEL = "speech";
    private static final int NOTIF_ID = 4101;

    static class Card {
        String id, w, n, e, t;
    }

    static class Session {
        List<String> ids = new ArrayList<>();
        List<Card> cards;               // null：沿用上次送來的整批字卡
        String removeId;                // JS 剛標成「會了」之類的卡，從輪次中拿掉
        float rate = 1f;
        boolean readZh = true, loop = false, shuffle = false, autoZh = true;
        String lang = "en-US";
        long sleepAt = 0;               // 睡眠模式停止時間（epoch 毫秒），0 = 沒啟用
    }

    interface Listener {
        void onCard(String id, List<String> idsOrNull);
        void onState(boolean active, boolean paused);
    }

    static volatile SpeechService instance;
    static volatile String curId;
    static volatile List<String> snapIds = new ArrayList<>();
    static volatile boolean curPaused = false;
    private static Session pending;
    private static Listener listener;

    static void setListener(Listener l) { listener = l; }
    static boolean isActive() { return instance != null; }

    static void startSession(Context ctx, Session s) {
        pending = s;
        Intent i = new Intent(ctx, SpeechService.class).setAction(ACTION_START);
        if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i); else ctx.startService(i);
    }

    /** 不通知網頁，直接停掉連播（例如要單獨念一個字之前） */
    static void stopQuiet() {
        final SpeechService s = instance;
        if (s != null) s.main.post(() -> s.stopSession(false));
    }

    // ---------------------------------------------------------------

    private final Handler main = new Handler(Looper.getMainLooper());
    private SpeechEngine engine;
    private final Map<String, Card> byId = new HashMap<>();
    private List<String> poolIds = new ArrayList<>();
    private List<Card> queue = new ArrayList<>();
    private int idx = 0;
    private boolean active = false, paused = false, pausedByFocus = false;
    private boolean loop, shuffle, readZh;
    private long sleepAt = 0;
    private int gen = 0;

    private AudioManager am;
    private AudioFocusRequest focusReq;
    private PowerManager.WakeLock wl;

    @Override public IBinder onBind(Intent intent) { return null; }

    @Override public void onCreate() {
        super.onCreate();
        instance = this;
        engine = new SpeechEngine(this);
        am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(CHANNEL, "連播朗讀", NotificationManager.IMPORTANCE_LOW);
            ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).createNotificationChannel(ch);
        }
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent == null ? null : intent.getAction();
        if (action == null || ACTION_START.equals(action)) {
            handleStart();
        } else if (!active) {
            stopSelf();                         // 殘留的通知按鈕，沒有進行中的連播
        } else if (ACTION_PAUSE.equals(action)) {
            pause(false);
        } else if (ACTION_RESUME.equals(action)) {
            resume();
        } else if (ACTION_NEXT.equals(action)) {
            next();
        } else if (ACTION_STOP.equals(action)) {
            stopSession(true);
        }
        return START_NOT_STICKY;
    }

    @Override public void onDestroy() {
        instance = null;
        curId = null;
        releaseResources();
        if (engine != null) engine.shutdown();
        super.onDestroy();
    }

    // ---------------------------------------------------------------

    private void handleStart() {
        Session s = pending;
        pending = null;
        startForegroundNow();
        if (s == null) { stopSession(false); return; }

        gen++;
        engine.stop();
        if (s.cards != null) {
            byId.clear();
            poolIds = new ArrayList<>();
            for (Card c : s.cards) { byId.put(c.id, c); poolIds.add(c.id); }
        }
        if (s.removeId != null) {
            byId.remove(s.removeId);
            poolIds.remove(s.removeId);
        }
        engine.configure(s.rate, s.lang, s.autoZh);
        loop = s.loop;
        shuffle = s.shuffle;
        readZh = s.readZh;
        sleepAt = s.sleepAt;

        queue = new ArrayList<>();
        for (String id : s.ids) {
            Card c = byId.get(id);
            if (c != null) queue.add(c);
        }
        idx = 0;
        active = true;
        paused = false;
        pausedByFocus = false;
        curPaused = false;
        snapIds = idsOf(queue);
        acquireResources();

        if (queue.isEmpty()) {
            wrap();
            if (queue.isEmpty()) { stopSession(true); return; }
            emitCard(true);
        } else {
            curId = queue.get(0).id;
        }
        updateNotification();
        playCurrent();
    }

    private void playCurrent() {
        if (!active || paused) return;
        if (idx >= queue.size()) {
            wrap();
            if (queue.isEmpty()) { stopSession(true); return; }
            emitCard(true);
        }
        Card c = queue.get(idx);
        curId = c.id;
        List<String> parts = new ArrayList<>();
        if (!isEmpty(c.w)) parts.add(c.w);
        if (readZh && !isEmpty(c.n)) parts.add(c.n);
        if (!isEmpty(c.e)) parts.add(c.e);
        if (readZh && !isEmpty(c.t)) parts.add(c.t);
        if (parts.isEmpty()) {
            main.postDelayed(() -> {
                if (sleepAt > 0 && System.currentTimeMillis() >= sleepAt) stopSession(true); else advance();
            }, 300);
            return;
        }

        final int my = ++gen;
        engine.speak(parts, completed -> {
            if (!completed || my != gen || paused) return;      // 被暫停、跳下一張或重新開始打斷
            main.postDelayed(() -> {
                if (my != gen || paused || !active) return;
                if (sleepAt > 0 && System.currentTimeMillis() >= sleepAt) { stopSession(true); return; }   // 睡眠時間到：唸完這張就停
                if (loop) playCurrent(); else advance();
            }, loop ? 900 : 1200);
        });
    }

    private void advance() {
        if (!active || paused) return;
        idx++;
        boolean wrapped = false;
        if (idx >= queue.size()) { wrap(); wrapped = true; }
        if (queue.isEmpty()) { stopSession(true); return; }
        emitCard(wrapped);
        updateNotification();
        playCurrent();
    }

    /** 這一輪唸完：重新排一輪（有開隨機就洗牌） */
    private void wrap() {
        List<Card> q = new ArrayList<>();
        for (String id : poolIds) {
            Card c = byId.get(id);
            if (c != null) q.add(c);
        }
        if (shuffle) Collections.shuffle(q);
        queue = q;
        idx = 0;
        snapIds = idsOf(queue);
    }

    private void emitCard(boolean wrapped) {
        if (idx >= queue.size()) return;
        curId = queue.get(idx).id;
        if (listener != null) listener.onCard(curId, wrapped ? snapIds : null);
    }

    private void pause(boolean byFocus) {
        if (!active || paused) return;
        paused = true;
        pausedByFocus = byFocus;
        curPaused = true;
        gen++;
        engine.stop();
        updateNotification();
        if (listener != null) listener.onState(true, true);
    }

    private void resume() {
        if (!active || !paused) return;
        paused = false;
        pausedByFocus = false;
        curPaused = false;
        updateNotification();
        if (listener != null) listener.onState(true, false);
        playCurrent();
    }

    private void next() {
        if (!active) return;
        gen++;
        engine.stop();
        if (paused) { paused = false; curPaused = false; }
        advance();
    }

    void stopSession(boolean emit) {
        active = false;
        paused = false;
        curPaused = false;
        gen++;
        if (engine != null) engine.stop();
        releaseResources();
        if (Build.VERSION.SDK_INT >= 24) stopForeground(Service.STOP_FOREGROUND_REMOVE); else stopForeground(true);
        stopSelf();
        if (emit && listener != null) listener.onState(false, false);
    }

    // ---------------------------------------------------------------

    private final AudioManager.OnAudioFocusChangeListener focusL = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS) pause(false);
        else if (change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) pause(true);
        else if (change == AudioManager.AUDIOFOCUS_GAIN && paused && pausedByFocus) resume();
    };

    private void acquireResources() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (wl == null) wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "flashcards:speech");
        if (!wl.isHeld()) wl.acquire(12 * 60 * 60 * 1000L);
        if (Build.VERSION.SDK_INT >= 26) {
            if (focusReq == null) {
                focusReq = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                        .setAudioAttributes(new AudioAttributes.Builder()
                                .setUsage(AudioAttributes.USAGE_MEDIA)
                                .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                                .build())
                        .setOnAudioFocusChangeListener(focusL, main)
                        .build();
            }
            am.requestAudioFocus(focusReq);
        } else {
            am.requestAudioFocus(focusL, AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        }
    }

    private void releaseResources() {
        if (wl != null && wl.isHeld()) wl.release();
        if (am != null) {
            if (Build.VERSION.SDK_INT >= 26) { if (focusReq != null) am.abandonAudioFocusRequest(focusReq); }
            else am.abandonAudioFocus(focusL);
        }
    }

    // ---------------------------------------------------------------

    private void startForegroundNow() {
        Notification n = buildNotification();
        if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
        else startForeground(NOTIF_ID, n);
    }

    private void updateNotification() {
        ((NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE)).notify(NOTIF_ID, buildNotification());
    }

    private Notification buildNotification() {
        Card c = (active && idx < queue.size()) ? queue.get(idx) : null;
        Notification.Builder b = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(this, CHANNEL) : new Notification.Builder(this);
        b.setSmallIcon(android.R.drawable.ic_media_play)
                .setContentTitle(c != null ? c.w : "字卡")
                .setContentText(paused ? "已暫停" : (c != null && !isEmpty(c.n) ? c.n : "連播中"))
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setShowWhen(false);
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        if (open != null) {
            b.setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
        }
        if (paused) b.addAction(action("繼續", ACTION_RESUME, 1, android.R.drawable.ic_media_play));
        else b.addAction(action("暫停", ACTION_PAUSE, 2, android.R.drawable.ic_media_pause));
        b.addAction(action("下一個", ACTION_NEXT, 3, android.R.drawable.ic_media_next));
        b.addAction(action("停止", ACTION_STOP, 4, android.R.drawable.ic_menu_close_clear_cancel));
        return b.build();
    }

    private Notification.Action action(String title, String act, int req, int iconRes) {
        PendingIntent pi = PendingIntent.getService(this, req,
                new Intent(this, SpeechService.class).setAction(act),
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Action.Builder(Icon.createWithResource(this, iconRes), title, pi).build();
    }

    private static List<String> idsOf(List<Card> cards) {
        List<String> ids = new ArrayList<>(cards.size());
        for (Card c : cards) ids.add(c.id);
        return ids;
    }

    private static boolean isEmpty(String s) { return s == null || s.trim().isEmpty(); }
}
