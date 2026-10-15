/**
 * SHEPU CHAT — music.js
 * Synchronized Room Radio & Shared Music Player.
 * Plays randomly shuffled playlists from assets/music/*.mp3
 * in real-time sync across all devices in the room.
 */

const RoomMusic = (() => {
  // Default music track inventory from assets/music
  const DEFAULT_TRACKS = [
    { id: 'm1', name: 'Track 1', file: 'm1.mp3', src: 'assets/music/m1.mp3' },
    { id: 'm2', name: 'Track 2', file: 'm2.mp3', src: 'assets/music/m2.mp3' },
    { id: 'm3', name: 'Track 3', file: 'm3.mp3', src: 'assets/music/m3.mp3' },
    { id: 'm4', name: 'Track 4', file: 'm4.mp3', src: 'assets/music/m4.mp3' },
    { id: 'm5', name: 'Track 5', file: 'm5.mp3', src: 'assets/music/m5.mp3' },
    { id: 'm6', name: 'Track 6', file: 'm6.mp3', src: 'assets/music/m6.mp3' },
  ];

  let _availableTracks = [...DEFAULT_TRACKS];
  let _playlist = [];
  let _currentIndex = 0;
  let _isPlaying = false;
  let _audio = new Audio();
  let _roomId = null;
  let _memberId = null;
  let _displayName = 'Member';
  let _broadcastChan = null;
  let _userInteracted = false;
  let _lastSyncTimestamp = 0;

  // DOM Elements
  let _headerBtn, _equalizer, _idleIcon;
  let _playerBar, _disc, _trackTitle, _trackMeta;
  let _playBtn, _iconPlay, _iconPause, _prevBtn, _nextBtn;
  let _volSlider, _volBtn, _closeBtn;

  // ── Fisher-Yates Random Playlist Generator ────────────────────
  function _createRandomPlaylist(tracks) {
    const list = [...tracks];
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  // ── Initialize Room Music ─────────────────────────────────────
  async function init({ roomId, memberId, displayName }) {
    _roomId = roomId || 'default';
    _memberId = memberId || 'u_' + Math.random().toString(36).slice(2, 8);
    _displayName = displayName || 'Member';

    // Local volume preference
    const savedVol = localStorage.getItem('shepu_music_vol');
    _audio.volume = savedVol !== null ? parseFloat(savedVol) : 0.7;

    // Cross-tab broadcast channel for local multi-window sync
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        _broadcastChan = new BroadcastChannel('pchat_music_' + _roomId);
        _broadcastChan.onmessage = (e) => {
          if (e.data && e.data.type === 'music_sync') {
            handleSyncEvent(e.data.payload);
          }
        };
      } catch (err) {
        console.warn('[RoomMusic] BroadcastChannel error:', err);
      }
    }

    // Try fetching available tracks dynamically from relay server if available
    _fetchAvailableTracks();

    // Bind DOM elements
    _bindDOM();

    // Audio element events
    _audio.addEventListener('ended', () => {
      if (_isPlaying && _playlist.length) {
        _advanceNext(true); // Automatically advance to next track in playlist
      }
    });

    _audio.addEventListener('error', (e) => {
      console.warn('[RoomMusic] Audio error on track:', _playlist[_currentIndex]?.src, e);
    });

    // Mark interaction on any user click
    const markInteraction = () => {
      _userInteracted = true;
      document.removeEventListener('click', markInteraction);
      document.removeEventListener('keydown', markInteraction);
    };
    document.addEventListener('click', markInteraction, { once: true });
    document.addEventListener('keydown', markInteraction, { once: true });

    // Request current room music state from active peers
    setTimeout(() => {
      _broadcast({ action: 'request_state', senderId: _memberId });
    }, 1200);
  }

  async function _fetchAvailableTracks() {
    try {
      const res = await fetch('/api/music_list', { signal: AbortSignal.timeout(1500) });
      if (res.ok) {
        const data = await res.json();
        if (data.success && Array.isArray(data.tracks) && data.tracks.length) {
          _availableTracks = data.tracks;
          console.log('[RoomMusic] Loaded tracks from relay server:', _availableTracks.length);
        }
      }
    } catch {}
  }

  // ── Bind UI DOM Elements ───────────────────────────────────────
  function _bindDOM() {
    _headerBtn   = document.getElementById('room-music-btn');
    _equalizer   = document.getElementById('music-equalizer');
    _idleIcon    = document.getElementById('music-icon-idle');

    _playerBar   = document.getElementById('room-music-player');
    _disc        = document.getElementById('music-player-disc');
    _trackTitle  = document.getElementById('music-track-title');
    _trackMeta   = document.getElementById('music-track-meta');

    _playBtn     = document.getElementById('music-play-btn');
    _iconPlay    = document.querySelector('#music-play-btn .icon-play');
    _iconPause   = document.querySelector('#music-play-btn .icon-pause');
    _prevBtn     = document.getElementById('music-prev-btn');
    _nextBtn     = document.getElementById('music-next-btn');

    _volSlider   = document.getElementById('music-vol-slider');
    _volBtn      = document.getElementById('music-vol-btn');
    _closeBtn    = document.getElementById('music-close-btn');

    if (!_headerBtn) return;

    // Header Music Button click -> toggle music or open player bar
    _headerBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _userInteracted = true;
      if (!_isPlaying && (!_playlist.length || _audio.paused)) {
        // Start fresh random playlist and play
        _startSyncedPlayback();
      } else {
        // If already playing, toggle player bar or play/pause
        if (_playerBar && _playerBar.classList.contains('hidden')) {
          _playerBar.classList.remove('hidden');
        } else {
          _togglePlayPause();
        }
      }
    });

    // Play/Pause button on floating bar
    _playBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _userInteracted = true;
      _togglePlayPause();
    });

    // Next track
    _nextBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _userInteracted = true;
      _advanceNext(false);
    });

    // Prev track
    _prevBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      _userInteracted = true;
      _advancePrev();
    });

    // Volume slider (Personal listening volume)
    if (_volSlider) {
      _volSlider.value = _audio.volume;
      _volSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        _audio.volume = val;
        localStorage.setItem('shepu_music_vol', val);
        _updateVolIcon(val);
      });
    }

    // Mute button
    _volBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_audio.volume > 0) {
        _audio._prevVol = _audio.volume;
        _audio.volume = 0;
        if (_volSlider) _volSlider.value = 0;
      } else {
        const restore = _audio._prevVol || 0.7;
        _audio.volume = restore;
        if (_volSlider) _volSlider.value = restore;
      }
      _updateVolIcon(_audio.volume);
    });

    // Close button (Hides bar, music continues playing)
    _closeBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      if (_playerBar) _playerBar.classList.add('hidden');
    });
  }

  function _updateVolIcon(vol) {
    if (!_volBtn) return;
    if (vol === 0) {
      _volBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>';
    } else {
      _volBtn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>';
    }
  }

  // ── Start Synced Playback (Random Playlist) ────────────────────
  function _startSyncedPlayback() {
    _playlist = _createRandomPlaylist(_availableTracks);
    _currentIndex = 0;
    const currentTrack = _playlist[_currentIndex];

    _playLocalTrack(currentTrack, 0);

    const payload = {
      action: 'play',
      playlist: _playlist,
      trackIndex: 0,
      currentTime: 0,
      timestamp: Date.now(),
      senderId: _memberId,
      senderName: _displayName,
    };

    _broadcast(payload);
    _showSyncToast('Started room music 🎵');
  }

  // ── Toggle Play / Pause ───────────────────────────────────────
  function _togglePlayPause() {
    if (!_playlist.length) {
      _startSyncedPlayback();
      return;
    }

    if (_isPlaying) {
      // Pause
      _audio.pause();
      _isPlaying = false;
      _updateUI();

      const payload = {
        action: 'pause',
        playlist: _playlist,
        trackIndex: _currentIndex,
        currentTime: _audio.currentTime,
        timestamp: Date.now(),
        senderId: _memberId,
        senderName: _displayName,
      };

      _broadcast(payload);
      _showSyncToast('Paused music ⏸');
    } else {
      // Resume
      const currentTrack = _playlist[_currentIndex];
      _playLocalTrack(currentTrack, _audio.currentTime || 0);

      const payload = {
        action: 'play',
        playlist: _playlist,
        trackIndex: _currentIndex,
        currentTime: _audio.currentTime || 0,
        timestamp: Date.now(),
        senderId: _memberId,
        senderName: _displayName,
      };

      _broadcast(payload);
      _showSyncToast('Resumed music ▶️');
    }
  }

  // ── Advance Next Track ────────────────────────────────────────
  function _advanceNext(autoAdvance = false) {
    if (!_playlist.length) return;
    _currentIndex = (_currentIndex + 1) % _playlist.length;
    const nextTrack = _playlist[_currentIndex];

    _playLocalTrack(nextTrack, 0);

    const payload = {
      action: 'play',
      playlist: _playlist,
      trackIndex: _currentIndex,
      currentTime: 0,
      timestamp: Date.now(),
      senderId: _memberId,
      senderName: _displayName,
    };

    _broadcast(payload);
    if (!autoAdvance) _showSyncToast(`Next: ${nextTrack.name} ⏭`);
  }

  // ── Advance Prev Track ────────────────────────────────────────
  function _advancePrev() {
    if (!_playlist.length) return;
    if (_audio.currentTime > 3) {
      _audio.currentTime = 0;
    } else {
      _currentIndex = (_currentIndex - 1 + _playlist.length) % _playlist.length;
    }
    const track = _playlist[_currentIndex];

    _playLocalTrack(track, 0);

    const payload = {
      action: 'play',
      playlist: _playlist,
      trackIndex: _currentIndex,
      currentTime: 0,
      timestamp: Date.now(),
      senderId: _memberId,
      senderName: _displayName,
    };

    _broadcast(payload);
    _showSyncToast(`Playing: ${track.name} ⏮`);
  }

  // ── Play Track Locally ─────────────────────────────────────────
  function _playLocalTrack(track, seekSeconds = 0) {
    if (!track || !track.src) return;

    if (_audio.src !== location.origin + '/' + track.src && !_audio.src.endsWith(track.src)) {
      _audio.src = track.src;
    }

    if (seekSeconds > 0) {
      try { _audio.currentTime = seekSeconds; } catch {}
    }

    _isPlaying = true;
    _updateUI();

    const playPromise = _audio.play();
    if (playPromise !== undefined) {
      playPromise.catch((err) => {
        console.warn('[RoomMusic] Autoplay deferred:', err.message);
        _isPlaying = false;
        _updateUI();
        _promptAutoplayUnlock();
      });
    }
  }

  // ── Autoplay Policy Prompt ────────────────────────────────────
  function _promptAutoplayUnlock() {
    if (document.getElementById('music-unlock-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'music-unlock-banner';
    banner.className = 'music-unlock-toast';
    banner.innerHTML = `
      <div class="music-unlock-content">
        <span class="music-unlock-icon">🎵</span>
        <div class="music-unlock-text">
          <strong>Room Radio Live</strong>
          <span>Click to listen together with the room</span>
        </div>
      </div>
      <button class="btn btn-sm btn-primary music-unlock-btn" type="button">Listen</button>
    `;

    banner.onclick = () => {
      banner.remove();
      _userInteracted = true;
      if (_playlist.length) {
        _playLocalTrack(_playlist[_currentIndex], _audio.currentTime || 0);
      }
    };

    document.body.appendChild(banner);
  }

  // ── Handle Incoming Sync Event ────────────────────────────────
  function handleSyncEvent(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.senderId === _memberId) return; // Ignore own echoes

    const { action, playlist, trackIndex, currentTime, timestamp, senderName } = payload;

    if (action === 'request_state') {
      // If we are currently playing, send our active playback state back
      if (_isPlaying && _playlist.length) {
        _broadcast({
          action: 'play',
          playlist: _playlist,
          trackIndex: _currentIndex,
          currentTime: _audio.currentTime,
          timestamp: Date.now(),
          senderId: _memberId,
          senderName: _displayName,
        });
      }
      return;
    }

    if (action === 'play') {
      if (Array.isArray(playlist) && playlist.length) {
        _playlist = playlist;
      }
      _currentIndex = typeof trackIndex === 'number' ? trackIndex : _currentIndex;
      const track = _playlist[_currentIndex] || _availableTracks[0];

      // Latency compensation
      const elapsed = timestamp ? (Date.now() - timestamp) / 1000 : 0;
      const targetTime = Math.max(0, (currentTime || 0) + (elapsed > 0 && elapsed < 8 ? elapsed : 0));

      _playLocalTrack(track, targetTime);
      _showSyncToast(`${senderName || 'Someone'} started ${track.name} 🎵`);
    } else if (action === 'pause') {
      _isPlaying = false;
      _audio.pause();
      if (typeof currentTime === 'number') {
        try { _audio.currentTime = currentTime; } catch {}
      }
      _updateUI();
      _showSyncToast(`${senderName || 'Someone'} paused music ⏸`);
    }
  }

  // ── Broadcast Event to Mesh & BroadcastChannel ─────────────────
  function _broadcast(payload) {
    // 1. P2P Mesh WebRTC broadcast (across remote devices)
    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastMusic) {
      P2PSync.broadcastMusic(payload);
    }

    // 2. Local BroadcastChannel (cross-tab on same browser)
    if (_broadcastChan) {
      try {
        _broadcastChan.postMessage({ type: 'music_sync', payload });
      } catch {}
    }
  }

  // ── Update Visual UI State ────────────────────────────────────
  function _updateUI() {
    const track = _playlist[_currentIndex] || null;

    // Header Music Button state
    if (_headerBtn) {
      if (_isPlaying) {
        _headerBtn.classList.add('music-active');
        _equalizer?.classList.remove('hidden');
        _idleIcon?.classList.add('hidden');
        _headerBtn.title = `Playing: ${track?.name || 'Radio'} (Click to manage)`;
      } else {
        _headerBtn.classList.remove('music-active');
        _equalizer?.classList.add('hidden');
        _idleIcon?.classList.remove('hidden');
        _headerBtn.title = 'Room Music (Synced Playlist)';
      }
    }

    // Floating Player Bar state
    if (_playerBar) {
      if (_playlist.length) {
        _playerBar.classList.remove('hidden');
      }

      if (_trackTitle) {
        _trackTitle.textContent = track ? `${track.name}` : 'Random Playlist';
      }

      if (_trackMeta) {
        _trackMeta.textContent = _playlist.length
          ? `Synced Radio · Track ${_currentIndex + 1} of ${_playlist.length}`
          : 'Ready to play';
      }

      // Disc rotation animation
      if (_disc) {
        if (_isPlaying) _disc.classList.add('spinning');
        else _disc.classList.remove('spinning');
      }

      // Play/Pause icon
      if (_iconPlay && _iconPause) {
        if (_isPlaying) {
          _iconPlay.classList.add('hidden');
          _iconPause.classList.remove('hidden');
        } else {
          _iconPlay.classList.remove('hidden');
          _iconPause.classList.add('hidden');
        }
      }
    }
  }

  function _showSyncToast(msg) {
    if (typeof UI !== 'undefined' && UI.toast) {
      UI.toast('info', 'Room Music', msg, 3000);
    }
  }

  return {
    init,
    handleSyncEvent,
  };
})();

window.RoomMusic = RoomMusic;
