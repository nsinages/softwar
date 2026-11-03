/**
 * N Signage Display Controller
 * Controls dynamic media playback on Raspberry Pi display.
 *
 * Media comes exclusively from GET /api/media — no filename is ever
 * hardcoded or entered manually. This page is served by the same Flask
 * app it polls, so its own origin *is* the Pi's base URL.
 */

(function () {
  // Configurable playback settings.
  const SETTINGS = {
    imageDurationMs: 5000,   // default 5s per image
    pollIntervalMs: 5000,    // re-check /api/media every 5s
    offlineAfterFailures: 2, // consecutive failed polls before showing "waiting" screen
  };

  const PI_BASE_URL = window.location.origin;

  // DOM Elements
  const videoPlayer = document.getElementById('videoPlayer');
  const imagePlayer = document.getElementById('imagePlayer');
  const noMediaFallback = document.getElementById('noMediaFallback');
  const offlineFallback = document.getElementById('offlineFallback');

  // Playlist State
  let playlist = [];
  let currentIndex = -1;
  let currentItem = null;
  let imageTimer = null;
  let isPlaying = false;
  let consecutiveFailures = 0;

  function init() {
    setupEventListeners();
    fetchPlaylist();
    setInterval(fetchPlaylist, SETTINGS.pollIntervalMs);
  }

  function setupEventListeners() {
    // Video ended event -> advance to next item
    videoPlayer.addEventListener('ended', function () {
      playNext();
    });

    // Handle video playback errors without crashing
    videoPlayer.addEventListener('error', function (err) {
      console.error("Video error on file:", currentItem ? currentItem.name : "unknown", err);
      scheduleNextFallback();
    });

    // Handle image load errors without crashing
    imagePlayer.addEventListener('error', function (err) {
      console.error("Image error on file:", currentItem ? currentItem.name : "unknown", err);
      scheduleNextFallback();
    });
  }

  function scheduleNextFallback() {
    clearImageTimer();
    setTimeout(playNext, 2000);
  }

  function clearImageTimer() {
    if (imageTimer) {
      clearTimeout(imageTimer);
      imageTimer = null;
    }
  }

  function mediaURL(item) {
    // Always build the URL from the item's own url field — never a
    // hardcoded filename. PI_BASE_URL is derived from window.location,
    // so this works whether the Pi is reached via IP or hostname.
    return PI_BASE_URL + item.url;
  }

  async function fetchPlaylist() {
    try {
      const response = await fetch('/api/media');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      const mediaList = data.media || data.files || [];

      consecutiveFailures = 0;
      hideOfflineFallback();
      updatePlaylistState(mediaList);
    } catch (err) {
      console.error("Failed to fetch media list:", err);
      consecutiveFailures += 1;
      if (consecutiveFailures >= SETTINGS.offlineAfterFailures) {
        showOfflineFallback();
      }
    }
  }

  function showOfflineFallback() {
    clearImageTimer();
    videoPlayer.pause();
    videoPlayer.style.display = 'none';
    imagePlayer.style.display = 'none';
    noMediaFallback.style.display = 'none';
    offlineFallback.style.display = 'flex';
    isPlaying = false;
  }

  function hideOfflineFallback() {
    offlineFallback.style.display = 'none';
  }

  function updatePlaylistState(newMediaList) {
    const hadMedia = playlist.length > 0;
    const previousItemName = currentItem ? currentItem.name : null;
    playlist = newMediaList;

    if (playlist.length === 0) {
      // No media available
      clearImageTimer();
      videoPlayer.pause();
      videoPlayer.style.display = 'none';
      imagePlayer.style.display = 'none';
      noMediaFallback.style.display = 'flex';
      currentIndex = -1;
      currentItem = null;
      isPlaying = false;
      return;
    }

    // Hide fallback screens once media is present
    noMediaFallback.style.display = 'none';

    // Nothing was playing yet (first load, came back from empty, or was
    // showing the offline screen) — start from the top of the playlist.
    if (!isPlaying || currentIndex === -1 || !hadMedia) {
      playItem(0);
      return;
    }

    if (previousItemName) {
      const stillExists = playlist.some((item) => item.name === previousItemName);
      if (!stillExists) {
        // The item currently on screen was deleted from the Pi — move on
        // without restarting the whole playlist.
        clearImageTimer();
        playItem(Math.min(currentIndex, playlist.length - 1));
        return;
      }

      // The playlist order can shift when files are added/removed (it's
      // re-sorted by name on the server). Resync currentIndex to the
      // currently playing item's new position so playNext() advances
      // correctly, without touching what's already on screen.
      const resyncedIndex = playlist.findIndex((item) => item.name === previousItemName);
      if (resyncedIndex !== -1) {
        currentIndex = resyncedIndex;
      }
    }
  }

  function playItem(index) {
    if (playlist.length === 0) {
      updatePlaylistState([]);
      return;
    }

    clearImageTimer();

    currentIndex = (index + playlist.length) % playlist.length;
    currentItem = playlist[currentIndex];
    isPlaying = true;

    const url = mediaURL(currentItem);

    if (currentItem.type === 'video') {
      // Configure and play video
      imagePlayer.style.display = 'none';
      videoPlayer.style.display = 'block';

      // Only update src if changed to prevent unnecessary re-buffering
      if (videoPlayer.getAttribute('src') !== url) {
        videoPlayer.src = url;
      }
      videoPlayer.currentTime = 0;

      const playPromise = videoPlayer.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.warn("Autoplay prevention or playback error:", error);
          // Retry with mute forced or advance after timeout
          videoPlayer.muted = true;
          videoPlayer.play().catch(() => scheduleNextFallback());
        });
      }
    } else if (currentItem.type === 'image') {
      // Pause video and configure image
      videoPlayer.pause();
      videoPlayer.style.display = 'none';
      imagePlayer.src = url;
      imagePlayer.style.display = 'block';

      imageTimer = setTimeout(playNext, SETTINGS.imageDurationMs);
    }
  }

  function playNext() {
    if (playlist.length === 0) {
      updatePlaylistState([]);
      return;
    }
    playItem(currentIndex + 1);
  }

  // Start on page load
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
