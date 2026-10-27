package com.flashcards.app;

import android.content.Context;
import android.media.AudioAttributes;
import android.os.Handler;
import android.os.Looper;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 系統 TTS 的包裝。一段文字裡的中文／英文會分開念，各自切換成對應的語言。
 * 所有公開方法都可以從任何執行緒呼叫，內部一律在主執行緒執行。
 */
public class SpeechEngine {

    public interface Done {
        /** completed=false 表示被打斷（停止、換成別段、TTS 不可用） */
        void onDone(boolean completed);
    }

    private static class Step {
        String text;
        boolean zh;
        int gapMs;
    }

    private final Handler main = new Handler(Looper.getMainLooper());
    private TextToSpeech tts;
    private boolean ready = false;
    private boolean failed = false;
    private final List<Runnable> waiting = new ArrayList<>();

    private float rate = 1f;
    private Locale mainLocale = Locale.US;
    private boolean autoZh = true;

    private int token = 0;
    private Done current;
    private String waitId;
    private Runnable stepDone;
    private Runnable timeout;
    private int idCounter = 0;

    public SpeechEngine(Context ctx) {
        tts = new TextToSpeech(ctx.getApplicationContext(), status -> main.post(() -> {
            if (status == TextToSpeech.SUCCESS) {
                ready = true;
                tts.setAudioAttributes(new AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build());
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String utteranceId) {}
                    @Override public void onDone(String utteranceId) { finishUtterance(utteranceId); }
                    @Override public void onError(String utteranceId) { finishUtterance(utteranceId); }
                });
            } else {
                failed = true;
            }
            List<Runnable> run = new ArrayList<>(waiting);
            waiting.clear();
            for (Runnable r : run) r.run();
        }));
    }

    public void configure(float rate, String lang, boolean autoZh) {
        this.rate = rate <= 0 ? 1f : rate;
        this.mainLocale = Locale.forLanguageTag(lang == null || lang.isEmpty() ? "en-US" : lang);
        this.autoZh = autoZh;
    }

    /** 依序念出每一段（段與段之間停 350ms）。結束時呼叫 done。 */
    public void speak(final List<String> parts, final Done done) {
        main.post(() -> {
            cancelInternal();
            final int my = token;
            current = done;
            Runnable go = () -> {
                if (my != token) return;
                if (failed || tts == null) { finish(my, false); return; }
                tts.setSpeechRate(rate);
                runStep(my, buildSteps(parts), 0);
            };
            if (ready || failed) go.run(); else waiting.add(go);
        });
    }

    public void stop() {
        main.post(this::cancelInternal);
    }

    public void shutdown() {
        main.post(() -> {
            cancelInternal();
            if (tts != null) { tts.shutdown(); tts = null; }
        });
    }

    // ---------------------------------------------------------------

    private void cancelInternal() {
        token++;
        if (timeout != null) { main.removeCallbacks(timeout); timeout = null; }
        stepDone = null;
        waitId = null;
        if (tts != null && ready) tts.stop();
        Done d = current;
        current = null;
        if (d != null) d.onDone(false);
    }

    private void finish(int my, boolean completed) {
        if (my != token) return;
        Done d = current;
        current = null;
        if (d != null) d.onDone(completed);
    }

    private void finishUtterance(final String id) {
        main.post(() -> {
            if (id != null && id.equals(waitId) && stepDone != null) {
                Runnable r = stepDone;
                stepDone = null;
                waitId = null;
                if (timeout != null) { main.removeCallbacks(timeout); timeout = null; }
                r.run();
            }
        });
    }

    private void runStep(final int my, final List<Step> steps, final int i) {
        if (my != token) return;
        if (i >= steps.size()) { finish(my, true); return; }
        final Step s = steps.get(i);
        Runnable speakNow = () -> {
            if (my != token) return;
            int r = tts.setLanguage(s.zh ? Locale.TAIWAN : mainLocale);
            if (s.zh && (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED)) {
                runStep(my, steps, i + 1);          // 這台裝置沒有中文語音：跳過這段
                return;
            }
            final String id = "u" + (++idCounter);
            waitId = id;
            stepDone = () -> runStep(my, steps, i + 1);
            long ms = 4000L + (long) (s.text.length() * 350f / Math.max(rate, 0.3f));
            timeout = () -> {
                if (my == token && id.equals(waitId) && stepDone != null) {
                    Runnable r2 = stepDone;
                    stepDone = null;
                    waitId = null;
                    r2.run();
                }
            };
            main.postDelayed(timeout, ms);
            int res = tts.speak(s.text, TextToSpeech.QUEUE_FLUSH, null, id);
            if (res != TextToSpeech.SUCCESS) {
                main.removeCallbacks(timeout);
                timeout = null;
                stepDone = null;
                waitId = null;
                runStep(my, steps, i + 1);
            }
        };
        if (s.gapMs > 0) main.postDelayed(speakNow, s.gapMs); else speakNow.run();
    }

    private List<Step> buildSteps(List<String> parts) {
        List<Step> out = new ArrayList<>();
        for (int i = 0; i < parts.size(); i++) {
            List<Step> segs = segments(parts.get(i));
            for (int j = 0; j < segs.size(); j++) {
                Step s = segs.get(j);
                s.gapMs = j == 0 ? (i > 0 ? 350 : 0) : 120;
                out.add(s);
            }
        }
        return out;
    }

    /** 把文字切成中文／非中文片段（數字、空白、半形標點跟著前一段；全形標點算中文） */
    private List<Step> segments(String text) {
        List<Step> out = new ArrayList<>();
        String s = text == null ? "" : text;
        if (!autoZh) {
            if (!s.trim().isEmpty()) out.add(step(s.trim(), false));
            return out;
        }
        StringBuilder pend = new StringBuilder();
        StringBuilder cur = null;
        boolean curZh = false;
        int n = s.length();
        for (int k = 0; k < n; ) {
            int cp = s.codePointAt(k);
            k += Character.charCount(cp);
            boolean zh;
            if (isZh(cp)) zh = true;
            else if (isLatin(cp)) zh = false;
            else {
                if (cur != null) cur.appendCodePoint(cp); else pend.appendCodePoint(cp);
                continue;
            }
            if (cur != null && curZh == zh) {
                cur.appendCodePoint(cp);
            } else {
                if (cur != null) out.add(step(cur.toString().trim(), curZh));
                cur = new StringBuilder(pend);
                pend.setLength(0);
                cur.appendCodePoint(cp);
                curZh = zh;
            }
        }
        if (cur != null) out.add(step(cur.toString().trim(), curZh));
        else if (pend.toString().trim().length() > 0) out.add(step(pend.toString().trim(), false));
        List<Step> clean = new ArrayList<>();
        for (Step st : out) if (!st.text.isEmpty()) clean.add(st);
        return clean;
    }

    private static Step step(String text, boolean zh) {
        Step st = new Step();
        st.text = text;
        st.zh = zh;
        return st;
    }

    private static boolean isZh(int c) {
        return (c >= 0x3400 && c <= 0x9FFF) || (c >= 0xF900 && c <= 0xFAFF)
                || (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF);
    }

    private static boolean isLatin(int c) {
        return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= 0x00C0 && c <= 0x024F);
    }
}
