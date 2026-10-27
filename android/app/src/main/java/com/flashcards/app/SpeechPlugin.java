package com.flashcards.app;

import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/** 網頁 ↔ 原生朗讀的橋：speak（單次朗讀）、stop、startSession（連播）、getSession（切回前景時同步） */
@CapacitorPlugin(name = "Speech")
public class SpeechPlugin extends Plugin implements SpeechService.Listener {

    private SpeechEngine engine;
    private static boolean askedNotification = false;

    @Override
    public void load() {
        engine = new SpeechEngine(getContext());
        SpeechService.setListener(this);
    }

    @Override
    protected void handleOnDestroy() {
        SpeechService.setListener(null);
        if (engine != null) engine.shutdown();
        super.handleOnDestroy();
    }

    @PluginMethod
    public void speak(final PluginCall call) {
        JSArray arr = call.getArray("parts");
        List<String> parts = new ArrayList<>();
        if (arr != null) {
            for (int i = 0; i < arr.length(); i++) parts.add(arr.optString(i, ""));
        }
        SpeechService.stopQuiet();
        engine.configure(call.getFloat("rate", 1f), call.getString("lang", "en-US"), call.getBoolean("autoZh", true));
        engine.speak(parts, completed -> {
            JSObject r = new JSObject();
            r.put("completed", completed);
            call.resolve(r);
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        engine.stop();
        SpeechService.stopQuiet();
        call.resolve();
    }

    @PluginMethod
    public void startSession(PluginCall call) {
        JSArray cardsArr = call.getArray("cards");
        if (cardsArr == null && !SpeechService.isActive()) {
            call.reject("NEED_CARDS");
            return;
        }
        SpeechService.Session s = new SpeechService.Session();
        try {
            JSArray ids = call.getArray("ids");
            if (ids != null) for (int i = 0; i < ids.length(); i++) s.ids.add(ids.getString(i));
            if (cardsArr != null) {
                s.cards = new ArrayList<>();
                for (int i = 0; i < cardsArr.length(); i++) {
                    JSONObject o = cardsArr.getJSONObject(i);
                    SpeechService.Card c = new SpeechService.Card();
                    c.id = o.optString("id", "");
                    c.w = o.optString("w", "");
                    c.n = o.optString("n", "");
                    c.e = o.optString("e", "");
                    c.t = o.optString("t", "");
                    s.cards.add(c);
                }
            }
        } catch (Exception ex) {
            call.reject("bad payload", ex);
            return;
        }
        s.removeId = call.getString("remove");
        s.rate = call.getFloat("rate", 1f);
        s.readZh = call.getBoolean("readZh", true);
        s.loop = call.getBoolean("loop", false);
        s.shuffle = call.getBoolean("shuffle", false);
        s.autoZh = call.getBoolean("autoZh", true);
        s.lang = call.getString("lang", "en-US");

        engine.stop();
        askNotificationPermission();
        SpeechService.startSession(getContext(), s);
        call.resolve();
    }

    @PluginMethod
    public void getSession(PluginCall call) {
        JSObject r = new JSObject();
        boolean active = SpeechService.isActive();
        r.put("active", active);
        r.put("paused", SpeechService.curPaused);
        if (active) {
            r.put("id", SpeechService.curId);
            JSONArray ids = new JSONArray();
            for (String id : SpeechService.snapIds) ids.put(id);
            r.put("ids", ids);
        }
        call.resolve(r);
    }

    private void askNotificationPermission() {
        if (askedNotification || Build.VERSION.SDK_INT < 33) return;
        if (getContext().checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED) return;
        askedNotification = true;
        getActivity().runOnUiThread(() ->
                getActivity().requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, 4242));
    }

    // ---- SpeechService.Listener（在主執行緒呼叫）----

    @Override
    public void onCard(String id, List<String> ids) {
        JSObject d = new JSObject();
        d.put("id", id);
        if (ids != null) {
            JSONArray arr = new JSONArray();
            for (String x : ids) arr.put(x);
            d.put("ids", arr);
        }
        notifyListeners("card", d);
    }

    @Override
    public void onState(boolean active, boolean paused) {
        JSObject d = new JSObject();
        d.put("active", active);
        d.put("paused", paused);
        notifyListeners("state", d);
    }
}
