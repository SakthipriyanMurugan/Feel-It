package com.sakthi.feelit;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.view.KeyEvent;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

public class MainActivity extends BridgeActivity {
    private static final String CHANNEL_ID = "feel_it_media_channel";
    private static final int NOTIF_ID = 2026;
    private static final String ACTION_PLAY  = "com.sakthi.feelit.ACTION_PLAY";
    private static final String ACTION_PAUSE = "com.sakthi.feelit.ACTION_PAUSE";
    private static final String ACTION_NEXT  = "com.sakthi.feelit.ACTION_NEXT";
    private static final String ACTION_PREV  = "com.sakthi.feelit.ACTION_PREV";

    private MediaSession mediaSession;
    private NotificationManager notificationManager;
    private BroadcastReceiver mediaReceiver;
    private Bitmap cachedCoverBitmap = null;
    private String lastCoverUrl = "";
    private long lastBackPressTime = 0;
    private String currentTitle = "FEEL IT";
    private String currentArtist = "Music Feels Better Here";
    private boolean currentlyPlaying = false;
    private long currentPosition = 0;
    private long currentDuration = 0;
    private PowerManager.WakeLock wakeLock = null;

    private void manageWakeLock(boolean acquire) {
        try {
            if (acquire) {
                if (wakeLock == null) {
                    PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
                    if (pm != null) {
                        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FeelIt:MediaWakeLock");
                        wakeLock.setReferenceCounted(false);
                    }
                }
                if (wakeLock != null && !wakeLock.isHeld()) {
                    wakeLock.acquire(10 * 60 * 60 * 1000L); // 10 hours safety
                }
            } else {
                if (wakeLock != null && wakeLock.isHeld()) {
                    wakeLock.release();
                }
            }
        } catch (Exception ignored) {}
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setupEdgeToEdgeFullscreen();
        enableBackgroundAudio();
        setupBackButtonHandler();
        setupNativeMediaSystem();
        requestNotificationPermission();
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 101);
            }
        }
    }

    private void setupNativeMediaSystem() {
        try {
            notificationManager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID,
                    "FEEL IT Now Playing",
                    NotificationManager.IMPORTANCE_LOW // Silent: no sound or popups, pure media controls card
                );
                channel.setDescription("Shows active song controls on lock screen and quick settings");
                channel.setShowBadge(false);
                channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                if (notificationManager != null) {
                    notificationManager.createNotificationChannel(channel);
                }
            }

            mediaSession = new MediaSession(this, "FEEL_IT_MEDIA_SESSION");
            mediaSession.setFlags(
                MediaSession.FLAG_HANDLES_MEDIA_BUTTONS |
                MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS
            );
            mediaSession.setCallback(new MediaSession.Callback() {
                @Override
                public void onPlay() {
                    handleAction(ACTION_PLAY);
                }

                @Override
                public void onPause() {
                    handleAction(ACTION_PAUSE);
                }

                @Override
                public void onSkipToNext() {
                    handleAction(ACTION_NEXT);
                }

                @Override
                public void onSkipToPrevious() {
                    handleAction(ACTION_PREV);
                }

                @Override
                public void onStop() {
                    handleAction(ACTION_PAUSE);
                }

                @Override
                public void onSeekTo(long pos) {
                    runOnUiThread(() -> {
                        WebView wv = getBridge().getWebView();
                        if (wv != null) {
                            wv.evaluateJavascript("if(window.audioPlayer){window.audioPlayer.currentTime=" + (pos / 1000.0) + ";}", null);
                        }
                    });
                }

                @Override
                public boolean onMediaButtonEvent(Intent mediaButtonIntent) {
                    if (mediaButtonIntent != null) {
                        KeyEvent event = mediaButtonIntent.getParcelableExtra(Intent.EXTRA_KEY_EVENT);
                        if (event != null && event.getAction() == KeyEvent.ACTION_DOWN) {
                            int keyCode = event.getKeyCode();
                            if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || keyCode == KeyEvent.KEYCODE_HEADSETHOOK) {
                                handleAction(currentlyPlaying ? ACTION_PAUSE : ACTION_PLAY);
                                return true;
                            } else if (keyCode == KeyEvent.KEYCODE_MEDIA_PLAY) {
                                handleAction(ACTION_PLAY);
                                return true;
                            } else if (keyCode == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                                handleAction(ACTION_PAUSE);
                                return true;
                            } else if (keyCode == KeyEvent.KEYCODE_MEDIA_NEXT) {
                                handleAction(ACTION_NEXT);
                                return true;
                            } else if (keyCode == KeyEvent.KEYCODE_MEDIA_PREVIOUS) {
                                handleAction(ACTION_PREV);
                                return true;
                            } else if (keyCode == KeyEvent.KEYCODE_MEDIA_STOP) {
                                handleAction(ACTION_PAUSE);
                                return true;
                            }
                        }
                    }
                    return super.onMediaButtonEvent(mediaButtonIntent);
                }
            });
            mediaSession.setActive(true);

            // Register intent receiver for notification buttons
            mediaReceiver = new BroadcastReceiver() {
                @Override
                public void onReceive(Context context, Intent intent) {
                    if (intent != null && intent.getAction() != null) {
                        handleAction(intent.getAction());
                    }
                }
            };
            IntentFilter filter = new IntentFilter();
            filter.addAction(ACTION_PLAY);
            filter.addAction(ACTION_PAUSE);
            filter.addAction(ACTION_NEXT);
            filter.addAction(ACTION_PREV);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                registerReceiver(mediaReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                registerReceiver(mediaReceiver, filter);
            }

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void handleAction(String action) {
        runOnUiThread(() -> {
            WebView wv = getBridge().getWebView();
            if (wv == null) return;
            switch (action) {
                case ACTION_PLAY:
                    wv.evaluateJavascript("(function(){ if (window.audioPlayer && window.audioPlayer.paused) { window.audioPlayer.play(); } else if (window.togglePlayback) { window.togglePlayback(); } })();", null);
                    break;
                case ACTION_PAUSE:
                    wv.evaluateJavascript("(function(){ if (window.audioPlayer && !window.audioPlayer.paused) { window.audioPlayer.pause(); } else if (window.togglePlayback) { window.togglePlayback(); } })();", null);
                    break;
                case ACTION_NEXT:
                    wv.evaluateJavascript("(function(){ if (window.nextSong) { window.nextSong(); } })();", null);
                    break;
                case ACTION_PREV:
                    wv.evaluateJavascript("(function(){ if (window.previousSong) { window.previousSong(); } })();", null);
                    break;
            }
        });
    }

    private PendingIntent getActionPendingIntent(String action) {
        Intent intent = new Intent(action);
        intent.setPackage(getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(this, action.hashCode(), intent, flags);
    }

    public void updateSystemMediaControls(String title, String artist, String coverUrl, boolean isPlaying, long positionMs, long durationMs) {
        if (mediaSession == null || notificationManager == null) return;

        this.currentTitle = (title != null && !title.isEmpty()) ? title : "FEEL IT";
        this.currentArtist = (artist != null && !artist.isEmpty()) ? artist : "Tamil Melody";
        this.currentlyPlaying = isPlaying;
        this.currentPosition = positionMs;
        this.currentDuration = durationMs;

        try {
            // 1. Playback State
            long actions = PlaybackState.ACTION_PLAY
                         | PlaybackState.ACTION_PAUSE
                         | PlaybackState.ACTION_PLAY_PAUSE
                         | PlaybackState.ACTION_SKIP_TO_NEXT
                         | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                         | PlaybackState.ACTION_SEEK_TO
                         | PlaybackState.ACTION_STOP;

            int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
            float speed = isPlaying ? 1.0f : 0.0f;
            PlaybackState.Builder stateBuilder = new PlaybackState.Builder()
                .setActions(actions)
                .setState(state, positionMs, speed, SystemClock.elapsedRealtime());

            mediaSession.setPlaybackState(stateBuilder.build());
            manageWakeLock(isPlaying);

            // 2. Metadata (Title, Artist, Duration, Cover)
            MediaMetadata.Builder metaBuilder = new MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
                .putString(MediaMetadata.METADATA_KEY_ALBUM, "FEEL IT")
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs);

            if (cachedCoverBitmap != null && coverUrl != null && coverUrl.equals(lastCoverUrl)) {
                metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, cachedCoverBitmap);
                metaBuilder.putBitmap(MediaMetadata.METADATA_KEY_ART, cachedCoverBitmap);
            }

            mediaSession.setMetadata(metaBuilder.build());

            // 3. Post Notification with MediaStyle (Shows Quick Settings card & Lock Screen card)
            renderNotificationCard(cachedCoverBitmap);

            // 4. Download Cover Art in Background if changed
            if (coverUrl != null && !coverUrl.isEmpty() && !coverUrl.equals(lastCoverUrl)) {
                lastCoverUrl = coverUrl;
                new Thread(() -> {
                    try {
                        URL url = new URL(coverUrl);
                        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                        conn.setDoInput(true);
                        conn.setConnectTimeout(6000);
                        conn.setReadTimeout(6000);
                        conn.connect();
                        InputStream input = conn.getInputStream();
                        Bitmap bmp = BitmapFactory.decodeStream(input);
                        if (bmp != null) {
                            cachedCoverBitmap = bmp;
                            new Handler(Looper.getMainLooper()).post(() -> {
                                if (mediaSession != null) {
                                    MediaMetadata.Builder mb = new MediaMetadata.Builder()
                                        .putString(MediaMetadata.METADATA_KEY_TITLE, currentTitle)
                                        .putString(MediaMetadata.METADATA_KEY_ARTIST, currentArtist)
                                        .putString(MediaMetadata.METADATA_KEY_ALBUM, "FEEL IT")
                                        .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                                        .putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp)
                                        .putBitmap(MediaMetadata.METADATA_KEY_ART, bmp);
                                    mediaSession.setMetadata(mb.build());
                                    renderNotificationCard(bmp);
                                }
                            });
                        }
                    } catch (Exception ignored) {}
                }).start();
            }

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private void renderNotificationCard(Bitmap coverBmp) {
        if (mediaSession == null || notificationManager == null) return;

        try {
            Intent launchIntent = new Intent(this, MainActivity.class);
            launchIntent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent contentIntent = PendingIntent.getActivity(this, 0, launchIntent, flags);

            Notification.MediaStyle style = new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2);

            Notification.Builder builder = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);

            builder.setStyle(style)
                .setSmallIcon(R.mipmap.ic_launcher)
                .setContentTitle(currentTitle)
                .setContentText(currentArtist)
                .setContentIntent(contentIntent)
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .setOngoing(currentlyPlaying);

            if (currentDuration > 0) {
                builder.setProgress((int) (currentDuration / 1000), (int) (currentPosition / 1000), false);
            }

            // Previous Action (index 0)
            builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_previous, "Previous", getActionPendingIntent(ACTION_PREV)
            ).build());

            // Play/Pause Action (index 1)
            int playPauseIcon = currentlyPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
            String playPauseTitle = currentlyPlaying ? "Pause" : "Play";
            String playPauseAction = currentlyPlaying ? ACTION_PAUSE : ACTION_PLAY;
            builder.addAction(new Notification.Action.Builder(
                playPauseIcon, playPauseTitle, getActionPendingIntent(playPauseAction)
            ).build());

            // Next Action (index 2)
            builder.addAction(new Notification.Action.Builder(
                android.R.drawable.ic_media_next, "Next", getActionPendingIntent(ACTION_NEXT)
            ).build());

            if (coverBmp != null) {
                builder.setLargeIcon(coverBmp);
            }

            notificationManager.notify(NOTIF_ID, builder.build());

        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    public void clearSystemMediaControls() {
        try {
            currentlyPlaying = false;
            manageWakeLock(false);
            if (mediaSession != null) {
                mediaSession.setPlaybackState(
                    new PlaybackState.Builder()
                        .setActions(0)
                        .setState(PlaybackState.STATE_STOPPED, 0, 1.0f)
                        .build()
                );
            }
            if (notificationManager != null) {
                notificationManager.cancel(NOTIF_ID);
            }
        } catch (Exception ignored) {}
    }

    private void setupBackButtonHandler() {
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                try {
                    WebView webView = getBridge().getWebView();
                    if (webView != null) {
                        webView.evaluateJavascript(
                            "(function() { return (window.handleAndroidBackButton && window.handleAndroidBackButton()) ? 'true' : 'false'; })();",
                            value -> {
                                boolean handled = "\"true\"".equals(value) || "true".equals(value);
                                if (!handled) {
                                    // If at root/home, require double tap within 2 seconds to exit app
                                    long currentTime = System.currentTimeMillis();
                                    if (currentTime - lastBackPressTime < 2000) {
                                        finish();
                                    } else {
                                        lastBackPressTime = currentTime;
                                        webView.evaluateJavascript("window.showToast && window.showToast('Press back again to exit');", null);
                                    }
                                }
                            }
                        );
                    } else {
                        finish();
                    }
                } catch (Exception e) {
                    finish();
                }
            }
        });
    }

    private void setupEdgeToEdgeFullscreen() {
        try {
            Window window = getWindow();
            WindowCompat.setDecorFitsSystemWindows(window, false);

            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_NAVIGATION);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);

            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                window.getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }

            WindowInsetsControllerCompat controller =
                WindowCompat.getInsetsController(window, window.getDecorView());
            if (controller != null) {
                controller.setAppearanceLightStatusBars(false);
                controller.setAppearanceLightNavigationBars(false);
            }

            View decorView = window.getDecorView();
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                      | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                      | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            decorView.setSystemUiVisibility(flags);
        } catch (Exception ignored) {}
    }

    private void enableBackgroundAudio() {
        try {
            WebView webView = getBridge().getWebView();
            if (webView != null) {
                WebSettings settings = webView.getSettings();
                settings.setMediaPlaybackRequiresUserGesture(false);
                webView.setBackgroundColor(Color.parseColor("#050507"));

                // Expose native bridge for instant synchronization of system media controls
                webView.addJavascriptInterface(new FeelItNativeMediaInterface(), "FeelItNativeBridge");
            }
        } catch (Exception ignored) {}
    }

    public class FeelItNativeMediaInterface {
        @JavascriptInterface
        public void updatePlayback(String title, String artist, String coverUrl, boolean isPlaying, long positionMs, long durationMs) {
            runOnUiThread(() -> updateSystemMediaControls(title, artist, coverUrl, isPlaying, positionMs, durationMs));
        }

        @JavascriptInterface
        public void updatePosition(long positionMs, long durationMs, boolean isPlaying) {
            runOnUiThread(() -> {
                currentPosition = positionMs;
                currentDuration = durationMs;
                currentlyPlaying = isPlaying;
                if (mediaSession != null) {
                    long actions = PlaybackState.ACTION_PLAY
                                 | PlaybackState.ACTION_PAUSE
                                 | PlaybackState.ACTION_PLAY_PAUSE
                                 | PlaybackState.ACTION_SKIP_TO_NEXT
                                 | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                                 | PlaybackState.ACTION_SEEK_TO
                                 | PlaybackState.ACTION_STOP;
                    int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
                    float speed = isPlaying ? 1.0f : 0.0f;
                    mediaSession.setPlaybackState(new PlaybackState.Builder()
                        .setActions(actions)
                        .setState(state, positionMs, speed, SystemClock.elapsedRealtime())
                        .build());
                }
            });
        }

        @JavascriptInterface
        public void setPlayingState(boolean isPlaying) {
            runOnUiThread(() -> {
                currentlyPlaying = isPlaying;
                if (mediaSession != null) {
                    long actions = PlaybackState.ACTION_PLAY
                                 | PlaybackState.ACTION_PAUSE
                                 | PlaybackState.ACTION_PLAY_PAUSE
                                 | PlaybackState.ACTION_SKIP_TO_NEXT
                                 | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                                 | PlaybackState.ACTION_SEEK_TO
                                 | PlaybackState.ACTION_STOP;
                    int state = isPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
                    float speed = isPlaying ? 1.0f : 0.0f;
                    mediaSession.setPlaybackState(new PlaybackState.Builder()
                        .setActions(actions)
                        .setState(state, currentPosition, speed, SystemClock.elapsedRealtime())
                        .build());
                }
                manageWakeLock(isPlaying);
                renderNotificationCard(cachedCoverBitmap);
            });
        }

        @JavascriptInterface
        public void stopPlayback() {
            runOnUiThread(() -> clearSystemMediaControls());
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            setupEdgeToEdgeFullscreen();
        }
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        try {
            manageWakeLock(false);
            if (mediaReceiver != null) {
                unregisterReceiver(mediaReceiver);
            }
            if (mediaSession != null) {
                mediaSession.release();
            }
            if (notificationManager != null) {
                notificationManager.cancel(NOTIF_ID);
            }
        } catch (Exception ignored) {}
    }
}
