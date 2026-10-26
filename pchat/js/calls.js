/**
 * SHEPU ROOMS — calls.js
 * 2026 Next-Gen Audio & Video WebRTC Calling for Pchat shepu
 * Features:
 *  - Crystal-clear WebRTC Peer-to-Peer Audio & HD Video
 *  - Procedural Web Audio API sound synthesis (ringtones, chimes)
 *  - Real-time voice frequency visualizer & animated soundwave aura
 *  - Floating Picture-in-Picture (PiP) & Background Chat Multi-tasking
 *  - Live Screen Share with seamless camera swap
 *  - Zero external dependencies
 */

const CallManager = (() => {
  let _activeCall = null;         // Current MediaConnection
  let _localStream = null;        // Local MediaStream
  let _screenStream = null;       // Screen share stream if active
  let _screenPending = false;     // a screen-picker prompt is open
  let _remoteStream = null;       // Remote MediaStream
  let _callType = 'audio';        // 'audio' | 'video'
  let _callState = 'idle';        // 'idle' | 'calling' | 'incoming' | 'connected' | 'ended'
  let _isMuted = false;
  let _isVideoOff = false;
  let _isScreenSharing = false;
  let _isMinimized = false;
  let _callTimerInterval = null;
  let _callStartTime = 0;
  let _currentCallId = null;
  let _currentCallTargetId = null;  // set when the call goes to one member
  let _iceGraceTimer = null;      // grace period after a transient ICE drop
  const ICE_GRACE_MS = 12000;      // 'disconnected' must persist this long
  let _incomingCallData = null;
  let _pendingMediaConnection = null;
  let _incomingRingTimer = null;  // auto-decline an unanswered incoming call
  let _accepterPeerId = null;     // peer that accepted our outgoing call
  let _remotePeerId = null;       // peer on the active media connection
  let _placeholderTrack = null;   // black video track to keep a video m-line
  const _seenInviteIds = new Map(); // callId -> ts, dedupes P2P+Ntfy copies

  // Web Audio Context & Synthesizer
  let _audioCtx = null;
  let _ringNodes = [];
  let _analyser = null;
  let _animFrameId = null;

  // ── Procedural Sound Synthesizer (Web Audio API) ─────────────────
  function _getAudioContext() {
    if (!_audioCtx) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (AudioCtx) _audioCtx = new AudioCtx();
    }
    if (_audioCtx && _audioCtx.state === 'suspended') {
      _audioCtx.resume().catch(() => {});
    }
    return _audioCtx;
  }

  const CALL_SOUND_SRC = 'assets/sounds/call.mp3';
  let _callAudio = null;

  function _playCallSound(volume = 0.85) {
    _stopSounds();
    try {
      if (typeof Notify !== 'undefined' && Notify.isSoundOn && !Notify.isSoundOn()) return;
    } catch {}

    try {
      _callAudio = new Audio(CALL_SOUND_SRC);
      _callAudio.loop = true;
      _callAudio.volume = volume;
      const p = _callAudio.play();
      if (p && p.catch) {
        p.catch(err => {
          console.warn('[CallManager] call.mp3 autoplay blocked/failed, using fallback synth:', err);
          _playIncomingRingSynth();
        });
      }
    } catch (e) {
      console.warn('[CallManager] call.mp3 play error:', e);
      _playIncomingRingSynth();
    }
  }

  function _stopSounds() {
    if (_callAudio) {
      try {
        _callAudio.pause();
        _callAudio.currentTime = 0;
      } catch {}
      _callAudio = null;
    }
    _ringNodes.forEach(node => {
      try { node.stop(); } catch {}
      try { node.disconnect(); } catch {}
    });
    _ringNodes = [];
  }

  // Soft rhythmic sound during outgoing call
  function _playOutgoingRing() {
    _playCallSound(0.55);
  }

  // Paint the audio-stage avatar (initial + optional picture).
  function _paintAudioAvatar(name, picture) {
    const av = document.getElementById('call-audio-avatar');
    if (!av) return;
    const initial = (name ? String(name)[0] : '?').toUpperCase();
    av.innerHTML = '';
    av.textContent = initial;
    const pic = String(picture || '').trim();
    if (!pic) return;
    try {
      const img = document.createElement('img');
      img.src = pic;
      img.alt = '';
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
      img.onerror = () => { try { av.textContent = initial; } catch {} };
      av.appendChild(img);
    } catch { /* keep the initial */ }
  }

  // Call ringtone on incoming call
  function _playIncomingRing() {
    _playCallSound(0.85);
  }

  // Auto-decline an unanswered incoming call. Without this the ringtone kept
  // playing forever when the caller hung up or the accept signal was lost.
  const INCOMING_RING_TIMEOUT_MS = 45000;
  function _armIncomingRingTimeout(callId) {
    if (_incomingRingTimer) { clearTimeout(_incomingRingTimer); _incomingRingTimer = null; }
    _incomingRingTimer = setTimeout(() => {
      _incomingRingTimer = null;
      if (_callState !== 'incoming') return;
      if (callId && _currentCallId && callId !== _currentCallId) return;
      _stopSounds();
      _hideIncomingToast();
      _incomingCallData = null;
      _callState = 'idle';
      if (_pendingMediaConnection) {
        try { _pendingMediaConnection.close(); } catch {}
        _pendingMediaConnection = null;
      }
      const st = document.getElementById('call-status-subtitle');
      if (st) st.textContent = 'Missed call';
    }, INCOMING_RING_TIMEOUT_MS);
  }

  // Fallback harmonic melody if MP3 playback is restricted
  function _playIncomingRingSynth() {
    const ctx = _getAudioContext();
    if (!ctx) return;

    let stopped = false;
    const notes = [523.25, 659.25, 783.99, 1046.50, 783.99, 659.25]; // C5, E5, G5, C6 arpeggio

    const playMelody = () => {
      if (stopped || (_callState !== 'incoming' && _callState !== 'calling')) return;
      try {
        notes.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const gain = ctx.createGain();
          const noteStart = ctx.currentTime + (idx * 0.16);

          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, noteStart);

          gain.gain.setValueAtTime(0.0001, noteStart);
          gain.gain.exponentialRampToValueAtTime(0.2, noteStart + 0.04);
          gain.gain.exponentialRampToValueAtTime(0.0001, noteStart + 0.38);

          osc.connect(gain);
          gain.connect(ctx.destination);

          osc.start(noteStart);
          osc.stop(noteStart + 0.4);
          _ringNodes.push(osc);
        });

        setTimeout(() => {
          if (!stopped && (_callState === 'incoming' || _callState === 'calling')) playMelody();
        }, 2200);
      } catch {}
    };

    playMelody();
    _ringNodes.push({ stop: () => { stopped = true; }, disconnect: () => {} });
  }

  // Cheerful chime on connected
  function _playConnectedChime() {
    _stopSounds();
    const ctx = _getAudioContext();
    if (!ctx) return;
    try {
      [523.25, 659.25, 1046.50].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + (i * 0.09);
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.18, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch {}
  }

  // Gentle descending tone on call end
  function _playEndChime() {
    _stopSounds();
    const ctx = _getAudioContext();
    if (!ctx) return;
    try {
      [440, 349.23, 261.63].forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        const start = ctx.currentTime + (i * 0.1);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.14, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + 0.4);
      });
    } catch {}
  }

  // ── Voice Reactive Frequency Analyser ───────────────────────────
  function _setupAudioVisualizer(stream) {
    if (!stream) return;
    const ctx = _getAudioContext();
    if (!ctx) return;

    try {
      const audioTracks = stream.getAudioTracks();
      if (!audioTracks.length) return;

      const source = ctx.createMediaStreamSource(stream);
      _analyser = ctx.createAnalyser();
      _analyser.fftSize = 64;
      source.connect(_analyser);

      const bufferLength = _analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateEq = () => {
        if (!_analyser || _callState !== 'connected') return;
        _analyser.getByteFrequencyData(dataArray);

        // Calculate average volume
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
        const avg = sum / bufferLength;

        // Animate wave aura around avatar
        const rings = document.querySelectorAll('.call-wave-ring');
        if (avg > 18) {
          rings.forEach(r => r.classList.add('speaking'));
        } else {
          rings.forEach(r => r.classList.remove('speaking'));
        }

        // Animate voice equalizer bars
        const columns = document.querySelectorAll('.eq-column');
        columns.forEach((col, idx) => {
          const val = dataArray[idx % bufferLength] || 0;
          const h = Math.max(6, Math.min(32, (val / 255) * 34));
          col.style.height = `${h}px`;
        });

        _animFrameId = requestAnimationFrame(updateEq);
      };

      updateEq();
    } catch (e) {
      console.warn('[CallManager] Visualizer init skipped:', e);
    }
  }

  function _stopVisualizer() {
    if (_animFrameId) {
      cancelAnimationFrame(_animFrameId);
      _animFrameId = null;
    }
    _analyser = null;
    const rings = document.querySelectorAll('.call-wave-ring');
    rings.forEach(r => r.classList.remove('speaking'));
  }

  // ── Call Timer ──────────────────────────────────────────────────
  function _startCallTimer() {
    _callStartTime = Date.now();
    const timerEl = document.getElementById('call-duration-timer');
    if (timerEl) timerEl.textContent = '00:00';

    if (_callTimerInterval) clearInterval(_callTimerInterval);
    _callTimerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - _callStartTime) / 1000);
      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      if (timerEl) timerEl.textContent = `${mins}:${secs}`;
    }, 1000);
  }

  function _stopCallTimer() {
    if (_callTimerInterval) {
      clearInterval(_callTimerInterval);
      _callTimerInterval = null;
    }
  }

  // ── UI Injection (Modals & Overlays) ────────────────────────────
  function _ensureUIElements() {
    // 1. Incoming Call Toast
    if (!document.getElementById('incoming-call-toast')) {
      const incToast = document.createElement('div');
      incToast.id = 'incoming-call-toast';
      incToast.className = 'incoming-call-toast';
      incToast.style.display = 'none';
      incToast.innerHTML = `
        <div class="incoming-avatar-wrap">
          <div class="incoming-sonar-ring"></div>
          <div class="incoming-sonar-ring"></div>
          <div class="incoming-avatar-initial" id="incoming-avatar">?</div>
        </div>
        <div class="incoming-details">
          <div class="incoming-caller-name" id="incoming-caller-name">Incoming Call</div>
          <div class="incoming-call-type" id="incoming-call-type">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
            <span>Voice Call</span>
          </div>
        </div>
        <div class="incoming-actions">
          <button class="btn-call-decline" id="btn-incoming-decline" title="Decline">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
          </button>
          <button class="btn-call-answer" id="btn-incoming-answer" title="Accept Call">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg>
          </button>
        </div>
      `;
      document.body.appendChild(incToast);

      document.getElementById('btn-incoming-answer').addEventListener('click', () => acceptCall());
      document.getElementById('btn-incoming-decline').addEventListener('click', () => declineCall());
    }

    // 2. Active Call Overlay
    if (!document.getElementById('active-call-overlay')) {
      const callOverlay = document.createElement('div');
      callOverlay.id = 'active-call-overlay';
      callOverlay.className = 'call-overlay';
      callOverlay.style.display = 'none';
      callOverlay.innerHTML = `
        <!-- Call Header -->
        <div class="call-header">
          <div class="call-header-info">
            <span class="call-security-badge">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
              <span>P2P E2EE Direct</span>
            </span>
            <div class="call-duration-timer" id="call-duration-timer">00:00</div>
          </div>
          <div class="call-header-actions">
            <button class="call-icon-btn" id="call-btn-minimize" title="Minimize to PiP (Chat while talking)">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4 14 10 14 10 20"></polyline><polyline points="20 10 14 10 14 4"></polyline><line x1="14" y1="10" x2="21" y2="3"></line><line x1="3" y1="21" x2="10" y2="14"></line></svg>
            </button>
          </div>
        </div>

        <!-- Call Stage -->
        <div class="call-stage">
          <!-- Video Stage (shown in video calls) -->
          <div class="call-video-container" id="call-video-container" style="display:none;">
            <!-- muted: the hidden <audio> below is the ONLY audio source.
                 Attaching the same MediaStream to two un-muted elements made
                 the peer audible twice (doubled / comb-filtered voice). -->
            <video id="call-remote-video" class="call-remote-video" autoplay playsinline muted></video>
            <!-- Floating PiP Local Self-View -->
            <div class="call-local-pip" id="call-local-pip" title="Your camera">
              <video id="call-local-video" class="call-local-video" autoplay playsinline muted></video>
              <div class="call-local-pip-label">You</div>
            </div>
          </div>

          <!-- Audio Stage (shown in audio calls) -->
          <div class="call-audio-stage" id="call-audio-stage">
            <audio id="call-remote-audio" autoplay playsinline style="display:none;"></audio>
            <div class="call-audio-avatar-halo">
              <div class="call-wave-ring ring-1"></div>
              <div class="call-wave-ring ring-2"></div>
              <div class="call-wave-ring ring-3"></div>
              <div class="call-audio-avatar" id="call-audio-avatar">?</div>
            </div>
            <div class="call-peer-name" id="call-peer-name">Calling…</div>
            <div class="call-status-subtitle" id="call-status-subtitle">Establishing connection…</div>
            <div class="call-voice-equalizer" id="call-voice-equalizer">
              <span class="eq-column"></span>
              <span class="eq-column"></span>
              <span class="eq-column"></span>
              <span class="eq-column"></span>
              <span class="eq-column"></span>
              <span class="eq-column"></span>
              <span class="eq-column"></span>
            </div>
          </div>
        </div>

        <!-- Controls Toolbar Dock -->
        <div class="call-controls-dock">
          <!-- Mic toggle -->
          <button class="dock-btn" id="call-dock-mic" title="Mute/Unmute Mic">
            <svg id="icon-mic-on" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
            <svg id="icon-mic-off" class="hidden" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
          </button>

          <!-- Camera toggle -->
          <button class="dock-btn" id="call-dock-cam" title="Toggle Camera">
            <svg id="icon-cam-on" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
            <svg id="icon-cam-off" class="hidden" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M21 21l-3.34-3.34L3 3l1.41-1.41"></path><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m4 0h5a2 2 0 0 1 2 2v2"></path><polygon points="23 7 16 12 23 17 23 7"></polygon></svg>
          </button>

          <!-- Screen Share toggle -->
          <button class="dock-btn" id="call-dock-screen" title="Share Screen">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
          </button>

          <!-- End Call -->
          <button class="dock-btn-hangup" id="call-dock-hangup" title="End Call">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
          </button>
        </div>
      `;
      document.body.appendChild(callOverlay);

      // Event listeners for call controls
      document.getElementById('call-btn-minimize').addEventListener('click', toggleMinimize);
      document.getElementById('call-dock-mic').addEventListener('click', toggleMic);
      document.getElementById('call-dock-cam').addEventListener('click', toggleCamera);
      document.getElementById('call-dock-screen').addEventListener('click', toggleScreenShare);
      document.getElementById('call-dock-hangup').addEventListener('click', endCall);
    }
  }

  // ── Absolute Media Tracks Cleanup (Ensures Camera & Mic HW Turn Off) ──
  function _stopMediaTracks() {
    if (_localStream) {
      try {
        _localStream.getTracks().forEach(t => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      _localStream = null;
    }
    if (_screenStream) {
      try {
        _screenStream.getTracks().forEach(t => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      _screenStream = null;
    }
    if (_remoteStream) {
      try {
        _remoteStream.getTracks().forEach(t => {
          try {
            t.enabled = false;
            t.stop();
          } catch {}
        });
      } catch {}
      _remoteStream = null;
    }

    const localVideo = document.getElementById('call-local-video');
    if (localVideo) {
      try { localVideo.pause(); } catch {}
      localVideo.srcObject = null;
    }
    const remoteVideo = document.getElementById('call-remote-video');
    if (remoteVideo) {
      try { remoteVideo.pause(); } catch {}
      remoteVideo.srcObject = null;
    }
    const remoteAudio = document.getElementById('call-remote-audio');
    if (remoteAudio) {
      try { remoteAudio.pause(); } catch {}
      remoteAudio.srcObject = null;
    }
    _stopPlaceholderTrack();
  }

  // ── Local media acquisition (never blocks the call itself) ──────
  // Permission is only needed to SEND media — not to place/answer a
  // call. Getting media must never delay the ring or drop the call.
  const AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
  const VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' };
  // Some cameras reject facingMode/720p ideals while still working with a
  // plain video request; retry with this before giving up on video.
  const VIDEO_CONSTRAINTS_RELAXED = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const MEDIA_ERROR_TEXT = {
    NotAllowedError:  'Permission denied — open the address-bar lock icon, allow the mic/camera, then press the mic/camera button again.',
    SecurityError:    'The browser blocked mic/camera access. Allow it in site settings, then retry.',
    NotFoundError:    'No microphone/camera was found on this device.',
    DevicesNotFoundError: 'No microphone/camera was found on this device.',
    OverconstrainedError: 'This device cannot provide the requested camera settings.',
    ConstraintNotSatisfiedError: 'This device cannot provide the requested camera settings.',
    NotReadableError: 'The mic/camera is busy in another app/tab. Close it and retry.',
    TrackStartError:  'The mic/camera could not start. Close other apps using it and retry.',
    AbortError:       'The mic/camera request was interrupted. Try again.'
  };
  function _mediaErrorText(err) {
    const key = (err && (err.name || err.code)) || '';
    return MEDIA_ERROR_TEXT[key] || (err && err.message) || 'Microphone/camera unavailable.';
  }
  function _notifyMediaProblem(wantedVideo, err) {
    console.warn('[CallManager] Media unavailable:', err);
    if (typeof UI === 'undefined' || !UI.toast) return;
    const label = wantedVideo ? 'Camera/Mic blocked' : 'Microphone blocked';
    UI.toast('warning', label, _mediaErrorText(err) + ' The call still connects — you just won\'t send ' + (wantedVideo ? 'audio/video' : 'audio') + '.', 9000);
  }
  // One device worked, the other did not. Say clearly what still works —
  // the old all-or-nothing message wrongly claimed nothing was being sent
  // when the mic (or camera) fallback had in fact succeeded.
  function _notifyMediaPartial(kind, err) {
    console.warn('[CallManager] Partial media (' + kind + ' missing):', err);
    if (typeof UI === 'undefined' || !UI.toast) return;
    if (kind === 'video') {
      UI.toast('warning', 'Camera blocked', _mediaErrorText(err) + ' Voice is still being sent; tap the camera button to retry.', 9000);
    } else {
      UI.toast('warning', 'Microphone blocked', _mediaErrorText(err) + ' Camera is on, but others cannot hear you yet — tap the mic button to retry.', 9000);
    }
  }
  async function _getUserMediaVideoOnly() {
    try {
      return await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS });
    } catch (err) {
      if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        return await navigator.mediaDevices.getUserMedia({ video: VIDEO_CONSTRAINTS_RELAXED });
      }
      throw err;
    }
  }

  async function _acquireLocalMedia(type) {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      _notifyMediaProblem(type === 'video', new Error('Media devices need HTTPS (or localhost).'));
      return null;
    }
    if (type !== 'video') {
      try { return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS }); }
      catch (err) { _notifyMediaProblem(false, err); return null; }
    }

    let firstErr = null;
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS });
    } catch (err) {
      firstErr = err;
      if (err && (err.name === 'OverconstrainedError' || err.name === 'ConstraintNotSatisfiedError')) {
        try {
          return await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS, video: VIDEO_CONSTRAINTS_RELAXED });
        } catch (err2) { firstErr = err2; }
      }
    }

    // Camera missing/denied but the mic may still be fine → keep a voice channel.
    try {
      const audioOnly = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
      _notifyMediaPartial('video', firstErr);
      return audioOnly;
    } catch (audioErr) {
      // Mic denied but camera allowed → keep the camera instead of dropping
      // both. The user can grant/retry the mic from the mic button later.
      try {
        const videoOnly = await _getUserMediaVideoOnly();
        _notifyMediaPartial('audio', audioErr);
        return videoOnly;
      } catch (videoErr) {
        // Prefer an explicit permission error over a secondary device error.
        const finalErr = (audioErr && (audioErr.name === 'NotAllowedError' || audioErr.name === 'SecurityError'))
          ? audioErr : videoErr;
        _notifyMediaProblem(true, finalErr);
        return null;
      }
    }
  }
  function _attachLocalPreview() {
    if (!_localStream) return;
    try {
      const localVideo = document.getElementById('call-local-video');
      if (localVideo) localVideo.srcObject = _localStream;
    } catch {}
  }
  // A muted black track keeps a video m-line in the offer so the other side
  // can still send its camera/screen to us when our own camera is missing.
  function _placeholderVideoTrack() {
    try {
      if (_placeholderTrack && _placeholderTrack.readyState === 'live') return _placeholderTrack;
      const canvas = document.createElement('canvas');
      canvas.width = 16;
      canvas.height = 16;
      const ctx = canvas.getContext('2d');
      if (ctx) { ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 16, 16); }
      const stream = canvas.captureStream(1);
      _placeholderTrack = stream.getVideoTracks()[0] || null;
      return _placeholderTrack;
    } catch {
      return null;
    }
  }
  function _stopPlaceholderTrack() {
    if (!_placeholderTrack) return;
    try { _placeholderTrack.stop(); } catch {}
    _placeholderTrack = null;
  }
  // Best-effort: push a newly granted track into the live connection.
  function _addLocalTracksToActiveCall() {
    if (!_activeCall || !_activeCall.peerConnection || !_localStream) return;
    try {
      const pc = _activeCall.peerConnection;
      const senders = pc.getSenders();
      _localStream.getTracks().forEach(track => {
        if (!senders.some(s => s.track === track)) pc.addTrack(track, _localStream);
      });
    } catch (e) {
      console.warn('[CallManager] addTrack failed:', e);
    }
  }
  function _outgoingStream() {
    let outgoing = _localStream;
    if (!outgoing) return null;
    if (_callType === 'video' && outgoing.getVideoTracks().length === 0) {
      const placeholder = _placeholderVideoTrack();
      if (placeholder) outgoing = new MediaStream([...outgoing.getTracks(), placeholder]);
    }
    return outgoing;
  }
  // PeerJS does not renegotiate reliably, so when mic/camera permission is
  // granted mid-call we rebuild the media connection with the new stream.
  // Closing is done after detaching the old connection so its 'close'
  // listener cannot mistake this for a hang-up.
  function _restartMediaConnection(stream) {
    const outgoing = stream || _outgoingStream();
    if (!outgoing) return false;
    const peer = (typeof P2PSync !== 'undefined') ? P2PSync.getPeer() : null;
    const target = _remotePeerId || _accepterPeerId;
    if (!peer || peer.destroyed || !target) return false;
    try {
      // Send the new offer first; _setupMediaConnection() then swaps the
      // active connection and closes the old one without hanging up.
      const mediaConn = peer.call(target, outgoing, { metadata: { callType: _callType, callId: _currentCallId, restart: true } });
      // PeerJS returns undefined (instead of throwing) when the peer is
      // disconnected from the signalling server. Reporting success there made
      // the mic button look "unmuted" while the peer heard nothing.
      if (!mediaConn) {
        console.warn('[CallManager] peer.call() returned no connection');
        return false;
      }
      _setupMediaConnection(mediaConn);
      return true;
    } catch (e) {
      console.warn('[CallManager] Media reconnect failed:', e);
      return false;
    }
  }

  // ── Start Outgoing Call ─────────────────────────────────────────
  async function startCall(type = 'audio', targetMemberId = null, targetName = '') {
    if (_callState !== 'idle') {
      console.warn('[CallManager] Already in call or calling');
      return;
    }

    _callType = type;
    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    const params = new URLSearchParams(location.search);
    const roomId = session?.roomId || params.get('r') || 'room';
    const roomName = session?.roomName || params.get('n') || 'Room Call';
    // Per-member call button: invite only that member. The header call
    // buttons pass no target and keep ringing the whole room.
    const callTargetId = targetMemberId || null;
    const callTargetName = targetName || '';

    _callState = 'calling';
    _isMuted = false;
    _isVideoOff = false;
    _isScreenSharing = false;
    _accepterPeerId = null;
    // Remember whether this call goes to ONE member or to the whole room.
    // Only a targeted call may be aborted by that member's "busy".
    _currentCallTargetId = callTargetId;
    _currentCallId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const myCallId = _currentCallId;

    // 1. Immediately show call UI & start outgoing ringtone
    _ensureUIElements();
    _showCallOverlay();

    const nameEl = document.getElementById('call-peer-name');
    if (nameEl) nameEl.textContent = callTargetName || roomName;
    const statusEl = document.getElementById('call-status-subtitle');
    if (statusEl) statusEl.textContent = callTargetName ? `Calling ${callTargetName}…` : 'Calling…';
    // Audio-stage avatar for the outgoing call (was always "?")
    _paintAudioAvatar(callTargetName || roomName, '');

    _playOutgoingRing();

    try {
      window.PchatAnalytics?.logEvent('call_started', {
        call_type: type === 'video' ? 'video' : 'audio',
        targeted: !!callTargetId,
      });
    } catch {}

    // 2. RING FIRST. Getting mic/camera permission can hang on the prompt
    //    (or take seconds on a slow device). Previously the invite was only
    //    broadcast after that await, so the other side never saw the call.
    //    Send the invite now, then acquire media in the background.
    let callerPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';
    if (!callerPeerId && session?.role === 'owner') {
      const cleanId = String(roomId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
      callerPeerId = `pchat_h_${cleanId}`;
    }

    const invitePayload = {
      action: 'invite',
      callId: _currentCallId,
      roomId,
      callerId: session?.memberId || 'user',
      callerName: session?.displayName || 'Caller',
      callerPicture: session?.picture || '',
      callerPeerId,
      fromId: session?.memberId || 'user',
      fromPeerId: callerPeerId,
      callType: _callType,
      // Optional 1:1 target. Receivers ignore targeted invites addressed to
      // someone else, so a member-row call no longer rings the whole room.
      targetMemberId: callTargetId || undefined,
      targetName: callTargetName || undefined,
      timestamp: Date.now()
    };

    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
      P2PSync.broadcastCallSignal(invitePayload);
    }

    // 3. Acquire local media without blocking the ring. Failure is not fatal:
    //    the call continues receive-only and can be retried from the buttons.
    _localStream = await _acquireLocalMedia(type);
    // The user may have cancelled while the permission prompt was open.
    if (_localStream && (_callState === 'idle' || _currentCallId !== myCallId)) {
      try { _localStream.getTracks().forEach(t => t.stop()); } catch {}
      _localStream = null;
      return;
    }
    if (_localStream) {
      _attachLocalPreview();
      if (statusEl && _callState === 'calling') statusEl.textContent = 'Ringing…';
    } else if (statusEl && _callState === 'calling') {
      statusEl.textContent = 'Ringing (no mic/camera)';
    }
    _syncMediaButtons();

    // 4. The CALLEE is the only side that starts the media connection (see
    //    acceptCall). The caller never calls first, so both sides cannot
    //    create competing connections and tear the call down. We only
    //    reconnect if we had already answered the callee receive-only while
    //    waiting for our own permission.
    if (_localStream && _activeCall && _callState === 'connected') {
      _restartMediaConnection();
    }

    // 45s Timeout for No Answer
    setTimeout(() => {
      if (_callState === 'calling' && _currentCallId === myCallId) {
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'No Answer';
        // Re-check the call id: a new call started inside this 2s window must
        // NOT be torn down by the stale timer.
        setTimeout(() => {
          if (_callState === 'calling' && _currentCallId === myCallId) endCall(true);
        }, 2000);
      }
    }, 45000);
  }

  // ── Handle Incoming Signal ──────────────────────────────────────
  function handleIncomingSignal(payload) {
    if (!payload || !payload.action) return;

    // Discard stale signals older than 40 seconds (avoids replaying cached Ntfy history)
    if (payload.timestamp && (Date.now() - payload.timestamp > 40000)) {
      return;
    }

    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    const myMemberId = session?.memberId;
    const myPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';

    // Ignore self echoes (from NtfySync relay)
    if (myMemberId && (payload.fromId === myMemberId || payload.callerId === myMemberId)) return;
    if (myPeerId && (payload.fromPeerId === myPeerId || payload.callerPeerId === myPeerId)) return;

    if (payload.action === 'invite') {
      // A targeted (per-member) call must only reach that member.
      if (payload.targetMemberId && payload.targetMemberId !== myMemberId) return;

      // The same invite is sent over BOTH P2P and Ntfy (belt & braces), so
      // the second copy would otherwise look like a second call and answer
      // "busy", killing the caller's ring. Dedupe by callId first.
      const inviteId = payload.callId || '';
      const now = Date.now();
      if (_seenInviteIds.size > 20) {
        for (const [k, t] of _seenInviteIds) {
          if (now - t > 120000) _seenInviteIds.delete(k);
        }
      }
      if (inviteId && _seenInviteIds.has(inviteId)) {
        return; // duplicate copy of an invite we already handled
      }
      // Remember it before the busy branch too, otherwise the duplicate
      // copy would send a second busy signal.
      if (inviteId) _seenInviteIds.set(inviteId, now);

      if (_callState !== 'idle') {
        // Send busy signal back to caller
        if (typeof P2PSync !== 'undefined') {
          P2PSync.broadcastCallSignal({
            action: 'busy',
            callId: payload.callId,
            fromId: myMemberId || 'user',
            fromPeerId: myPeerId,
            timestamp: Date.now()
          });
        }
        return;
      }

      _currentCallId = payload.callId;
      _incomingCallData = payload;
      _callType = payload.callType || 'audio';
      _callState = 'incoming';

      _ensureUIElements();
      _showIncomingToast(payload);
      _playIncomingRing();
      _armIncomingRingTimeout(payload.callId);
    } else if (payload.action === 'accept') {
      if (_callState === 'calling' && (!_currentCallId || payload.callId === _currentCallId)) {
        _stopSounds();
        _playConnectedChime();
        _callState = 'connected';
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = _localStream ? 'Connected' : 'Connected (no mic/camera)';
        _startCallTimer();

        // Remember who accepted. The callee starts the media connection;
        // we may still be waiting on our own permission prompt.
        _accepterPeerId = payload.accepterPeerId || payload.fromPeerId || _accepterPeerId;

        // Prefer answering an offer the accepter already sent us. This works
        // even when WE have no mic/camera (answer without a stream = receive-only).
        // The callee is the side that starts media (see acceptCall); if it
        // cannot, it sends 'media-ready' and we call it instead. The caller
        // never calls first, which avoids two competing connections.
        if (_pendingMediaConnection) {
          try {
            _pendingMediaConnection.answer(_localStream || undefined);
            _setupMediaConnection(_pendingMediaConnection);
          } catch (e) {
            console.warn('[CallManager] Answer pending call error:', e);
          }
          _pendingMediaConnection = null;
        }
      } else if (_callState === 'incoming' && (!_currentCallId || payload.callId === _currentCallId)) {
        // Somebody ELSE picked up the call. Stop ringing — without this the
        // 'accept' signal was ignored while we were still in the 'incoming'
        // state, so this device kept ringing forever.
        _stopSounds();
        _hideIncomingToast();
        _incomingCallData = null;
        _callState = 'idle';
        if (_pendingMediaConnection) {
          try { _pendingMediaConnection.close(); } catch {}
          _pendingMediaConnection = null;
        }
        if (_incomingRingTimer) { clearTimeout(_incomingRingTimer); _incomingRingTimer = null; }
      }
    } else if (payload.action === 'media-ready') {
      // The callee accepted but could not start media itself (no mic/camera,
      // or it has no peer id for us). Call it so media can flow; it answers
      // with its stream, or receive-only when it has no device.
      if (!_currentCallId || !payload.callId || payload.callId === _currentCallId) {
        // 'media-ready' implies the call was accepted. The accept signal can
        // arrive after it on a multi-server relay, so finalize here too.
        if (_callState === 'calling') {
          _stopSounds();
          _playConnectedChime();
          _callState = 'connected';
          const st = document.getElementById('call-status-subtitle');
          if (st) st.textContent = 'Connected';
          _startCallTimer();
        }
        if (_callState === 'connected') {
          _accepterPeerId = payload.fromPeerId || payload.accepterPeerId || _accepterPeerId;
          const peer = (typeof P2PSync !== 'undefined') ? P2PSync.getPeer() : null;
          const outgoing = _outgoingStream();
          if (peer && !peer.destroyed && outgoing && !_activeCall && _accepterPeerId) {
            try {
              const mediaConn = peer.call(_accepterPeerId, outgoing, { metadata: { callType: _callType, callerName: session?.displayName, callId: _currentCallId, fallback: true } });
              if (mediaConn) _setupMediaConnection(mediaConn);
            } catch (e) {
              console.warn('[CallManager] Media-ready call error:', e);
            }
          }
        }
      }
    } else if (payload.action === 'decline') {
      if ((_callState === 'calling' || _callState === 'connected') && (!_currentCallId || payload.callId === _currentCallId)) {
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'Call Declined';
        _stopSounds();
        _playEndChime();
        const declinedCallId = _currentCallId;
        setTimeout(() => {
          if (_currentCallId === declinedCallId) endCall(false);
        }, 1600);
      }
    } else if (payload.action === 'end') {
      if (_callState !== 'idle' && (!_currentCallId || !payload.callId || payload.callId === _currentCallId)) {
        endCall(false);
      }
    } else if (payload.action === 'busy') {
      if (_callState === 'calling' && (!_currentCallId || payload.callId === _currentCallId)) {
        // A ROOM-WIDE call must not be torn down because ONE member is busy
        // (or is already in another call) — the other members are ringing
        // and may be about to answer. Only a call addressed to a single
        // member can be aborted by that member's "busy".
        if (!_currentCallTargetId) {
          const st = document.getElementById('call-status-subtitle');
          if (st) st.textContent = 'User is Busy';
          return;
        }
        if (payload.fromId !== _currentCallTargetId) return;

        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'User is Busy';
        _stopSounds();
        _playEndChime();
        const busyCallId = _currentCallId;
        setTimeout(() => {
          if (_currentCallId === busyCallId) endCall(false);
        }, 2000);
      }
    }
  }

  // ── Accept Incoming Call ────────────────────────────────────────
  async function acceptCall() {
    if (!_incomingCallData || _callState !== 'incoming') return;
    _stopSounds();
    _hideIncomingToast();

    const incoming = _incomingCallData;
    _callType = incoming.callType || 'audio';

    // Show the call and tell the caller we accepted IMMEDIATELY. Waiting for
    // the permission prompt here used to make an accepted call look unanswered.
    _callState = 'connected';
    _isMuted = false;
    _isVideoOff = false;

    _showCallOverlay();
    const peerNameEl = document.getElementById('call-peer-name');
    if (peerNameEl) peerNameEl.textContent = incoming.callerName || 'Room Member';
    const statusEl = document.getElementById('call-status-subtitle');
    if (statusEl) statusEl.textContent = 'Connecting…';
    // The audio-stage avatar was never filled in — it always showed "?".
    _paintAudioAvatar(incoming.callerName || 'Room Member', incoming.callerPicture || '');
    // A fresh call must not inherit the previous call's screen-share state.
    _isScreenSharing = false;
    try { document.getElementById('call-dock-screen')?.classList.remove('is-active'); } catch {}
    if (_incomingRingTimer) { clearTimeout(_incomingRingTimer); _incomingRingTimer = null; }

    _playConnectedChime();
    _startCallTimer();

    try {
      window.PchatAnalytics?.logEvent('call_accepted', {
        call_type: _callType === 'video' ? 'video' : 'audio',
      });
    } catch {}

    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    const myPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';

    // Broadcast accept signal with accepterPeerId
    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
      P2PSync.broadcastCallSignal({
        action: 'accept',
        callId: incoming.callId,
        fromId: session?.memberId || 'guest',
        fromPeerId: myPeerId,
        accepterPeerId: myPeerId,
        timestamp: Date.now()
      });
    }

    // Acquire local media, but NEVER decline because permission is missing.
    // A blocked camera/mic must not swallow the call: join receive-only and
    // let the user allow it, then retry from the mic/camera button.
    _localStream = await _acquireLocalMedia(_callType);
    // Cancelled/declined while the permission prompt was open?
    if (_callState === 'idle' || _incomingCallData !== incoming) {
      if (_localStream) {
        try { _localStream.getTracks().forEach(t => t.stop()); } catch {}
        _localStream = null;
      }
      return;
    }

    if (_localStream) {
      _attachLocalPreview();
      // If we already answered the caller receive-only while the permission
      // prompt was open, reconnect now so they can hear/see us too.
      if (_activeCall) _restartMediaConnection();
      if (statusEl) statusEl.textContent = 'Connecting…';
    } else if (statusEl) {
      statusEl.textContent = 'Connected (no mic/camera)';
    }
    _syncMediaButtons();

    // The callee starts the media connection: answer a pending offer, or call
    // the caller with our stream. If we have no mic/camera, tell the caller so
    // it can call us and we answer receive-only. On a video call, only start
    // the offer if we have a camera: an audio-only offer cannot carry the
    // caller's video back to us, so let the caller start it instead.
    const canStartMedia = !!_localStream && (_callType !== 'video' || _localStream.getVideoTracks().length > 0);
    if (_pendingMediaConnection) {
      try {
        _pendingMediaConnection.answer(_localStream || undefined);
        _setupMediaConnection(_pendingMediaConnection);
      } catch (e) {
        console.warn('[CallManager] Pending call answer error:', e);
      }
      _pendingMediaConnection = null;
    } else if (canStartMedia && !_activeCall && incoming.callerPeerId) {
      const peer = (typeof P2PSync !== 'undefined') ? P2PSync.getPeer() : null;
      if (peer && !peer.destroyed) {
        try {
          const mediaConn = peer.call(incoming.callerPeerId, _localStream, { metadata: { callType: _callType, callId: incoming.callId } });
          // peer.call() returns undefined (it does NOT throw) when the peer
          // is disconnected. Without this check _activeCall stayed null and
          // both sides showed "Connected" with a running timer while there
          // was no PeerConnection at all — a permanently dead call.
          if (!mediaConn) {
            console.warn('[CallManager] peer.call() returned no connection');
            UI.toast('error', 'Call failed', 'Could not reach the other device. Try again.');
            endCall(false);
            return;
          }
          _setupMediaConnection(mediaConn);
        } catch (e) {
          console.warn('[CallManager] Answer call error:', e);
          UI.toast('error', 'Call failed', 'Could not connect to the other device.');
          endCall(false);
        }
      }
    } else if (!_activeCall && typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
      // We could not start the media call ourselves (no device, or the invite
      // did not carry the caller's peer id). Ask the caller to call us.
      P2PSync.broadcastCallSignal({
        action: 'media-ready',
        callId: incoming.callId,
        fromId: session?.memberId || 'guest',
        fromPeerId: myPeerId,
        hasMedia: !!_localStream,
        timestamp: Date.now()
      });
    }
  }

  // ── Decline Call ────────────────────────────────────────────────
  function declineCall() {
    _stopSounds();
    _hideIncomingToast();

    if (_incomingCallData) {
      const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
      const myPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
        P2PSync.broadcastCallSignal({
          action: 'decline',
          callId: _incomingCallData.callId,
          fromId: session?.memberId || 'guest',
          fromPeerId: myPeerId,
          timestamp: Date.now()
        });
      }
      _incomingCallData = null;
    }

    if (_pendingMediaConnection) {
      try { _pendingMediaConnection.close(); } catch {}
      _pendingMediaConnection = null;
    }

    _stopMediaTracks();
    _callState = 'idle';
    _currentCallId = null;
    _currentCallTargetId = null;
  }

  // ── Setup MediaConnection Listeners ─────────────────────────────
  function _setupMediaConnection(conn) {
    if (!conn) return;
    const old = _activeCall;
    _activeCall = conn;
    _remotePeerId = conn.peer || _remotePeerId;
    // Close a replaced connection only after swapping _activeCall, so its
    // 'close' listener does not mistake the swap for a hang-up.
    if (old && old !== conn) {
      try { old.close(); } catch {}
    }

    conn.on('stream', (remoteStream) => {
      console.log('[CallManager] Remote stream received:', remoteStream.id);
      _remoteStream = remoteStream;

      _stopSounds();
      _playConnectedChime();
      _callState = 'connected';
      const st = document.getElementById('call-status-subtitle');
      if (st) st.textContent = 'Connected';
      _startCallTimer();

      const remoteAudio = document.getElementById('call-remote-audio');
      if (remoteAudio) {
        remoteAudio.srcObject = remoteStream;
        remoteAudio.play().catch(() => {});
      }

      const remoteVideo = document.getElementById('call-remote-video');
      if (remoteVideo) {
        // Only the <audio> element may play the remote voice — see the
        // markup note. (display:none does not stop a media element playing.)
        try { remoteVideo.muted = true; } catch {}
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(() => {});
      }

      // A video track can arrive mid-call (camera enabled later, or screen
      // share). Switch the receiver from the audio stage to the video stage.
      try {
        if (remoteStream.getVideoTracks && remoteStream.getVideoTracks().length > 0 && _callType !== 'video') {
          _callType = 'video';
          _updateStageDisplay();
        }
      } catch {}

      _setupAudioVisualizer(remoteStream);
    });

    conn.on('close', () => {
      console.log('[CallManager] MediaConnection closed.');
      // ONLY end call if it was ALREADY connected AND it is this active connection!
      // This prevents ringing calls from closing prematurely!
      if (_callState === 'connected' && _activeCall === conn) {
        endCall(false);
      }
    });

    conn.on('error', (err) => {
      console.warn('[CallManager] MediaConnection error:', err);
    });

    // ICE watchdog. PeerJS only auto-closes on 'failed'/'closed' (15-30s
    // later) and ignores 'disconnected' entirely — so a dead peer left the
    // overlay saying "Connected" with the timer running and no audio.
    try {
      if (typeof conn.on === 'function') {
        conn.on('iceStateChanged', (state) => {
          if (state === 'connected' || state === 'completed') {
            // The connection recovered — cancel any pending "lost" timer.
            if (_iceGraceTimer) { clearTimeout(_iceGraceTimer); _iceGraceTimer = null; }
            return;
          }
          if (state !== 'failed' && state !== 'disconnected' && state !== 'closed') return;
          if (_activeCall !== conn) return;
          if (_callState !== 'connected' && _callState !== 'calling') return;

          if (state === 'disconnected') {
            // 'disconnected' is explicitly TRANSIENT in WebRTC: a Wi-Fi →
            // mobile handover, a VPN toggle or a backgrounded phone tab
            // emits it for a few hundred milliseconds and the connection
            // often recovers on its own. Ending the call right away killed
            // live calls over a momentary blip, so give it a grace period.
            if (_iceGraceTimer) clearTimeout(_iceGraceTimer);
            _iceGraceTimer = setTimeout(() => {
              _iceGraceTimer = null;
              if (_activeCall !== conn) return;
              if (_callState !== 'connected' && _callState !== 'calling') return;
              const st = document.getElementById('call-status-subtitle');
              if (st) st.textContent = 'Connection lost';
              endCall(false);
            }, ICE_GRACE_MS);
            return;
          }

          // 'failed' / 'closed' — the connection is really gone.
          if (_iceGraceTimer) { clearTimeout(_iceGraceTimer); _iceGraceTimer = null; }
          const st = document.getElementById('call-status-subtitle');
          if (st) st.textContent = 'Connection lost';
          endCall(false);
        });
      }
    } catch { /* older PeerJS builds have no iceStateChanged */ }
  }

  // ── End Active Call ─────────────────────────────────────────────
  function endCall(sendSignal = true) {
    _stopSounds();
    _playEndChime();
    _stopCallTimer();
    _stopVisualizer();
    // Cancel a pending "connection lost" grace timer — the call is over.
    if (_iceGraceTimer) { clearTimeout(_iceGraceTimer); _iceGraceTimer = null; }

    if (sendSignal && _currentCallId) {
      const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
      const myPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
        P2PSync.broadcastCallSignal({
          action: 'end',
          callId: _currentCallId,
          fromId: session?.memberId || 'guest',
          fromPeerId: myPeerId,
          timestamp: Date.now()
        });
      }
    }

    _stopMediaTracks();

    // Close PeerJS call
    if (_activeCall) {
      try { _activeCall.close(); } catch {}
      _activeCall = null;
    }
    if (_pendingMediaConnection) {
      try { _pendingMediaConnection.close(); } catch {}
      _pendingMediaConnection = null;
    }

    _callState = 'idle';
    _currentCallId = null;
    _currentCallTargetId = null;
    _incomingCallData = null;
    _accepterPeerId = null;
    _remotePeerId = null;        // stale peer id must not be reused as target
    _isMinimized = false;
    _callType = 'audio';
    _isMuted = false;
    _isVideoOff = false;
    // Screen-share state must reset too, or the next call's Share button
    // takes the "revert" branch and never starts a share.
    _isScreenSharing = false;
    if (_incomingRingTimer) { clearTimeout(_incomingRingTimer); _incomingRingTimer = null; }
    try { document.getElementById('call-dock-screen')?.classList.remove('is-active'); } catch {}

    _hideCallOverlay();
    _hideIncomingToast();
  }

  // ── Controls: Mute, Camera, Screen Share ────────────────────────
  function _paintMicUI(muted) {
    const btn = document.getElementById('call-dock-mic');
    const micOn = document.getElementById('icon-mic-on');
    const micOff = document.getElementById('icon-mic-off');
    if (btn) btn.classList.toggle('is-off', muted);
    if (micOn) micOn.classList.toggle('hidden', muted);
    if (micOff) micOff.classList.toggle('hidden', !muted);
  }

  function _paintCamUI(off) {
    const btn = document.getElementById('call-dock-cam');
    const camOn = document.getElementById('icon-cam-on');
    const camOff = document.getElementById('icon-cam-off');
    if (btn) btn.classList.toggle('is-off', off);
    if (camOn) camOn.classList.toggle('hidden', off);
    if (camOff) camOff.classList.toggle('hidden', !off);
  }

  // Reflect what we ACTUALLY have: if the mic was denied, show the mic as
  // off (not falsely "on"); same for a blocked camera. Tapping the button
  // still re-requests permission.
  function _syncMediaButtons() {
    const hasAudio = !!(_localStream && _localStream.getAudioTracks().some(t => t.readyState === 'live'));
    const hasVideo = !!(_localStream && _localStream.getVideoTracks().some(t => t.readyState === 'live'));
    if (!hasAudio) _isMuted = true;
    if (!hasVideo) _isVideoOff = true;
    _paintMicUI(_isMuted);
    _paintCamUI(_isVideoOff);
  }

  async function toggleMic() {
    const liveAudio = _localStream
      ? _localStream.getAudioTracks().find(t => t.readyState === 'live')
      : null;

    if (!liveAudio) {
      // No mic track yet (permission denied earlier, or camera-only fallback).
      // Ask for audio only so an existing camera track is preserved.
      const retryStream = await _acquireLocalMedia('audio');
      if (!retryStream) return;
      if (_callState !== 'connected') {
        try { retryStream.getTracks().forEach(t => t.stop()); } catch {}
        return;
      }
      if (_localStream) {
        // Remove dead audio tracks, then attach only the new audio.
        _localStream.getAudioTracks().forEach(t => {
          if (t.readyState !== 'live') { try { _localStream.removeTrack(t); } catch {} }
        });
        retryStream.getVideoTracks().forEach(t => { try { t.stop(); } catch {} });
        retryStream.getAudioTracks().forEach(t => _localStream.addTrack(t));
      } else {
        _localStream = retryStream;
      }
      _attachLocalPreview();
      if (!_restartMediaConnection()) _addLocalTracksToActiveCall();
      _isMuted = false;
      _syncMediaButtons();
      const retryStatus = document.getElementById('call-status-subtitle');
      if (retryStatus && _callState === 'connected') retryStatus.textContent = 'Connected';
      return;
    }

    _isMuted = !_isMuted;
    liveAudio.enabled = !_isMuted;
    _paintMicUI(_isMuted);
  }

  async function toggleCamera() {
    if (!_localStream) {
      // Permission may have been granted after the call started — retry now.
      const retryStream = await _acquireLocalMedia('video');
      if (!retryStream) return;
      if (_callState !== 'connected') {
        try { retryStream.getTracks().forEach(t => t.stop()); } catch {}
        return;
      }
      _localStream = retryStream;
      _attachLocalPreview();
      if (!_restartMediaConnection()) _addLocalTracksToActiveCall();
      if (_localStream.getVideoTracks().some(t => t.readyState === 'live')) {
        _callType = 'video';
        _isVideoOff = false;
        _updateStageDisplay();
      }
      _syncMediaButtons();
      const retryStatus = document.getElementById('call-status-subtitle');
      if (retryStatus && _callState === 'connected') retryStatus.textContent = 'Connected';
      return;
    }
    const videoTrack = _localStream.getVideoTracks().find(t => t.readyState === 'live');

    if (videoTrack) {
      _isVideoOff = !_isVideoOff;
      videoTrack.enabled = !_isVideoOff;

      const btn = document.getElementById('call-dock-cam');
      const camOn = document.getElementById('icon-cam-on');
      const camOff = document.getElementById('icon-cam-off');

      if (btn) btn.classList.toggle('is-off', _isVideoOff);
      if (camOn) camOn.classList.toggle('hidden', _isVideoOff);
      if (camOff) camOff.classList.toggle('hidden', !_isVideoOff);
    } else {
      // Upgrade audio-only → video on the fly (also retries a blocked camera).
      if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        _notifyMediaProblem(true, new Error('Media devices need HTTPS (or localhost).'));
        return;
      }
      _getUserMediaVideoOnly()
        .then(newStream => {
          // The user may have ended the call while the camera prompt was open.
          if (_callState !== 'connected' || !_localStream) {
            try { newStream.getTracks().forEach(t => t.stop()); } catch {}
            return;
          }
          const newVideoTrack = newStream.getVideoTracks()[0];
          if (!newVideoTrack) {
            try { newStream.getTracks().forEach(t => t.stop()); } catch {}
            _notifyMediaProblem(true, new Error('No camera track was provided.'));
            return;
          }
          // Drop a dead video track before attaching the fresh one.
          _localStream.getVideoTracks().forEach(t => {
            if (t.readyState !== 'live') { try { _localStream.removeTrack(t); } catch {} }
          });
          _localStream.addTrack(newVideoTrack);
          _callType = 'video';
          _isVideoOff = false;
          _syncMediaButtons();
          _updateStageDisplay();

          const localVideo = document.getElementById('call-local-video');
          if (localVideo) localVideo.srcObject = _localStream;

          // PeerJS does not renegotiate new tracks reliably → rebuild the
          // media connection with the full audio+video stream.
          if (!_restartMediaConnection() && _activeCall && _activeCall.peerConnection) {
            const sender = _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(newVideoTrack);
            } else {
              _activeCall.peerConnection.addTrack(newVideoTrack, _localStream);
            }
          }
        })
        .catch(err => {
          _notifyMediaProblem(true, err);
        });
    }
  }

  async function _acquireDisplayMedia() {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      // System-audio capture is optional and unsupported in some browsers;
      // retry video-only instead of failing the whole share.
      if (err && (err.name === 'NotSupportedError' || err.name === 'OverconstrainedError' || err.name === 'TypeError')) {
        return await navigator.mediaDevices.getDisplayMedia({ video: true });
      }
      throw err;
    }
  }

  async function toggleScreenShare() {
    if (_isScreenSharing) {
      // Revert from screen share to camera
      if (_screenStream) {
        _screenStream.getTracks().forEach(t => t.stop());
        _screenStream = null;
      }
      _isScreenSharing = false;
      document.getElementById('call-dock-screen')?.classList.remove('is-active');

      const camTrack = _localStream
        ? _localStream.getVideoTracks().find(t => t.readyState === 'live')
        : null;
      if (_activeCall && _activeCall.peerConnection) {
        const sender = _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        // replaceTrack(null) stops sending video if there is no camera.
        if (sender) sender.replaceTrack(camTrack || null);
      }
      if (_localStream) {
        const localVideo = document.getElementById('call-local-video');
        if (localVideo) localVideo.srcObject = _localStream;
      }
      return;
    }

    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
      UI.toast('warning', 'Screen share unavailable', 'Screen sharing needs HTTPS (or localhost) and a browser/device that supports it.');
      return;
    }

    // A picker is already open — ignore the extra tap.
    if (_screenPending) return;
    _screenPending = true;

    try {
      _screenStream = await _acquireDisplayMedia();
      const screenTrack = _screenStream.getVideoTracks()[0];
      if (!screenTrack) throw new Error('No screen video track was provided.');

      // The user may have hung up (or the call may have ended) while the
      // browser's screen-picker dialog was open. Without this guard the
      // capture starts anyway, the track is never stopped, and the browser
      // keeps showing "You are sharing your screen" with no call to share
      // into — a real privacy leak.
      if (_callState !== 'connected' && _callState !== 'calling') {
        try { _screenStream.getTracks().forEach(t => t.stop()); } catch {}
        _screenStream = null;
        try { console.warn('[CallManager] screen share aborted — the call ended'); } catch {}
        return;
      }

      _isScreenSharing = true;
      document.getElementById('call-dock-screen')?.classList.add('is-active');

      // Auto-revert when user clicks "Stop sharing" in browser banner
      screenTrack.onended = () => {
        toggleScreenShare();
      };

      // If a video sender already exists, swapping tracks needs no
      // renegotiation. Otherwise rebuild the connection with screen + audio
      // so the other side actually receives the shared screen.
      const screenSender = (_activeCall && _activeCall.peerConnection)
        ? _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video')
        : null;
      if (screenSender) {
        screenSender.replaceTrack(screenTrack);
      } else {
        const outgoing = new MediaStream([
          ...(_localStream ? _localStream.getAudioTracks() : []),
          screenTrack
        ]);
        _restartMediaConnection(outgoing);
      }

      // Preview screen on local video PiP
      const localVideo = document.getElementById('call-local-video');
      if (localVideo) localVideo.srcObject = _screenStream;

      if (_callType !== 'video') {
        _callType = 'video';
        _updateStageDisplay();
      }
    } catch (err) {
      console.warn('[CallManager] Screen share error/cancelled:', err);
      if (_screenStream) {
        try { _screenStream.getTracks().forEach(t => t.stop()); } catch {}
        _screenStream = null;
      }
      _isScreenSharing = false;
      document.getElementById('call-dock-screen')?.classList.remove('is-active');
      if (err && err.name === 'NotAllowedError') {
        UI.toast('info', 'Screen share cancelled', 'No screen was shared.');
      } else if (typeof UI !== 'undefined' && UI.toast) {
        UI.toast('warning', 'Screen share failed', 'Screen sharing is not available on this device/browser, or permission was blocked.');
      }
    } finally {
      // Allow a new share request once this one settled. Without the flag
      // two quick taps opened two pickers and one capture was orphaned.
      _screenPending = false;
    }
  }

  function toggleMinimize() {
    _isMinimized = !_isMinimized;
    const overlay = document.getElementById('active-call-overlay');
    if (overlay) {
      overlay.classList.toggle('minimized', _isMinimized);
    }
  }

  // ── Stage & Display Helpers ─────────────────────────────────────
  function _updateStageDisplay() {
    const videoContainer = document.getElementById('call-video-container');
    const audioStage = document.getElementById('call-audio-stage');

    if (_callType === 'video') {
      if (videoContainer) videoContainer.style.display = 'flex';
      if (audioStage) audioStage.style.display = 'none';
    } else {
      if (videoContainer) videoContainer.style.display = 'none';
      if (audioStage) audioStage.style.display = 'flex';
    }
  }

  function _showCallOverlay() {
    _ensureUIElements();
    _updateStageDisplay();
    const overlay = document.getElementById('active-call-overlay');
    if (overlay) {
      // Always sync the PiP class with the actual state; a stale 'minimized'
      // class from a previous call used to make every new call open tiny.
      overlay.classList.toggle('minimized', _isMinimized);
      overlay.style.display = 'flex';
    }
    // Fresh call: no mute/camera state yet. Acquisition paints the truth.
    _paintMicUI(_isMuted);
    _paintCamUI(_isVideoOff);
  }

  function _hideCallOverlay() {
    const overlay = document.getElementById('active-call-overlay');
    if (overlay) {
      overlay.style.display = 'none';
      overlay.classList.remove('minimized');
    }
  }

  function _showIncomingToast(data) {
    _ensureUIElements();
    const toast = document.getElementById('incoming-call-toast');
    if (!toast) return;

    document.getElementById('incoming-caller-name').textContent = data.callerName || 'Room Member';
    const typeLabel = document.getElementById('incoming-call-type');
    if (typeLabel) {
      typeLabel.innerHTML = (data.callType === 'video')
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg><span>HD Video Call</span>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"></path></svg><span>Voice Call</span>';
    }

    const av = document.getElementById('incoming-avatar');
    if (av) {
      const pic = (typeof data.callerPicture === 'string') ? data.callerPicture.trim() : '';
      // Only image URLs; reject anything with raw quotes/angle brackets/space.
      // Build with DOM properties (not innerHTML) so the value can never
      // break out of the src attribute.
      const picSafe = pic
        && /^(data:image\/|https?:\/\/)/i.test(pic)
        && !/[\s"'<>]/.test(pic);
      av.textContent = '';
      if (picSafe) {
        const img = document.createElement('img');
        img.src = pic;
        img.alt = '';
        img.style.cssText = 'width:100%;height:100%;border-radius:50%;object-fit:cover;';
        img.onerror = () => {
          av.textContent = (data.callerName ? String(data.callerName)[0] : '?').toUpperCase();
        };
        av.appendChild(img);
      } else {
        av.textContent = (data.callerName ? String(data.callerName)[0] : '?').toUpperCase();
      }
    }

    toast.style.display = 'flex';
  }

  function _hideIncomingToast() {
    const toast = document.getElementById('incoming-call-toast');
    if (toast) toast.style.display = 'none';
  }

  // ── Hook into PeerJS Incoming Calls ─────────────────────────────
  function onIncomingMediaCall(mediaConn) {
    console.log('[CallManager] Handling incoming PeerJS MediaConnection from:', mediaConn.peer);
    if (_callState === 'connected') {
      // Already accepted: answer immediately. If we have no mic/camera, answer
      // without a stream (receive-only) so the other side is still heard/seen.
      //
      // BUT only for the peer we are already talking to. Answering any other
      // offer let a second accepter hijack the established call: the new
      // connection replaced (and closed) the first one, dropping the original
      // participant silently.
      const meta = mediaConn.metadata || {};
      const offerCallId = meta.callId || null;
      const sameCall = !offerCallId || !_currentCallId || offerCallId === _currentCallId;
      const samePeer = !_remotePeerId || !mediaConn.peer || mediaConn.peer === _remotePeerId;
      if (!sameCall || !samePeer) {
        try { mediaConn.close(); } catch {}
        return;
      }
      try {
        mediaConn.answer(_localStream || undefined);
        _setupMediaConnection(mediaConn);
      } catch (e) {
        console.warn('[CallManager] Error answering incoming media call:', e);
      }
    } else if (_callState === 'calling') {
      // The callee's media offer proves it accepted; the accept signal can
      // arrive later on a multi-server relay. Finalize the call now.
      const meta = mediaConn.metadata || {};
      if (!meta.callId || meta.callId === _currentCallId) {
        _stopSounds();
        _playConnectedChime();
        _callState = 'connected';
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'Connected';
        _startCallTimer();
        _accepterPeerId = mediaConn.peer || _accepterPeerId;
        try {
          mediaConn.answer(_localStream || undefined);
          _setupMediaConnection(mediaConn);
        } catch (e) {
          console.warn('[CallManager] Error answering incoming media call:', e);
        }
      } else {
        // Close the previous pending connection — dropping it on the floor
        // leaked its RTCPeerConnection / ICE agent for the whole session.
        if (_pendingMediaConnection) {
          try { _pendingMediaConnection.close(); } catch {}
        }
        _pendingMediaConnection = mediaConn;
      }
    } else if (_callState === 'incoming') {
      // Store connection until the user clicks "Accept"
      if (_pendingMediaConnection) {
        try { _pendingMediaConnection.close(); } catch {}
      }
      _pendingMediaConnection = mediaConn;
    } else {
      // Stray offer while idle — don't leave it hanging.
      try { mediaConn.close(); } catch {}
    }
  }

  // ── Initialize CallManager ──────────────────────────────────────
  function init() {
    _ensureUIElements();

    // Hook into P2PSync if available
    if (typeof P2PSync !== 'undefined') {
      if (P2PSync.onCallSignal) {
        P2PSync.onCallSignal((payload) => handleIncomingSignal(payload));
      }
      if (P2PSync.onIncomingMediaCall) {
        P2PSync.onIncomingMediaCall((mediaConn) => onIncomingMediaCall(mediaConn));
      }
    }

    // Attach click listeners to room header call buttons
    const audioBtn = document.getElementById('header-audio-call-btn');
    if (audioBtn) {
      audioBtn.addEventListener('click', () => startCall('audio'));
    }

    const videoBtn = document.getElementById('header-video-call-btn');
    if (videoBtn) {
      videoBtn.addEventListener('click', () => startCall('video'));
    }

    // Auto-launch call if arrived with ?autocall=audio or ?autocall=video
    try {
      const urlParams = new URLSearchParams(window.location.search);
      const autoCall = urlParams.get('autocall');
      if (autoCall === 'audio' || autoCall === 'video') {
        const cleanUrl = new URL(window.location.href);
        cleanUrl.searchParams.delete('autocall');
        window.history.replaceState({}, document.title, cleanUrl.toString());
        setTimeout(() => startCall(autoCall), 600);
      }
    } catch {}

    // Preload call ringtone
    try {
      const preload = new Audio(CALL_SOUND_SRC);
      preload.preload = 'auto';
    } catch {}

    // Clean up all hardware media tracks immediately if page is hidden/unloaded
    window.addEventListener('beforeunload', () => {
      if (_callState !== 'idle') {
        endCall(true);
      } else {
        _stopMediaTracks();
      }
    });

    window.addEventListener('pagehide', () => {
      if (_callState !== 'idle') {
        endCall(true);
      } else {
        _stopMediaTracks();
      }
    });
  }

  return {
    init,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    toggleMic,
    toggleCamera,
    toggleScreenShare,
    toggleMinimize,
    handleIncomingSignal,
    onIncomingMediaCall,
  };
})();

window.CallManager = CallManager;

// Auto-init when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => CallManager.init());
} else {
  CallManager.init();
}
