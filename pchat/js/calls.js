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
  let _remoteStream = null;       // Remote MediaStream
  let _callType = 'audio';        // 'audio' | 'video'
  let _callState = 'idle';        // 'idle' | 'calling' | 'incoming' | 'connected' | 'ended'
  let _isMuted = false;
  let _isVideoOff = false;
  let _isScreenSharing = false;
  let _isMinimized = false;
  let _callTimerInterval = null;
  let _callStartTime = 0;
  let _incomingCallData = null;
  let _pendingMediaConnection = null;

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

  // Call ringtone on incoming call
  function _playIncomingRing() {
    _playCallSound(0.85);
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
            <video id="call-remote-video" class="call-remote-video" autoplay playsinline></video>
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

  // ── Start Outgoing Call ─────────────────────────────────────────
  async function startCall(type = 'audio') {
    _callType = type;
    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    const params = new URLSearchParams(location.search);
    const roomId = session?.roomId || params.get('r') || 'room';
    const roomName = session?.roomName || params.get('n') || 'Room Call';

    _callState = 'calling';
    _isMuted = false;
    _isVideoOff = false;
    _isScreenSharing = false;

    // 1. Immediately show the stylish call screen & start outgoing ring
    _ensureUIElements();
    _showCallOverlay();

    const nameEl = document.getElementById('call-peer-name');
    if (nameEl) nameEl.textContent = roomName;
    const statusEl = document.getElementById('call-status-subtitle');
    if (statusEl) statusEl.textContent = 'Calling…';

    _playOutgoingRing();

    // 2. Safely acquire local media
    if (navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') {
      try {
        const constraints = {
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: (type === 'video') ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
        };
        _localStream = await navigator.mediaDevices.getUserMedia(constraints);
        const localVideo = document.getElementById('call-local-video');
        if (localVideo && _callType === 'video') {
          localVideo.srcObject = _localStream;
        }
      } catch (err) {
        console.warn('[CallManager] Camera/Mic access warning:', err);
        if (type === 'video') {
          try {
            _localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            _callType = 'audio';
            _updateStageDisplay();
          } catch (e) {
            console.warn('[CallManager] Mic fallback failed:', e);
          }
        }
      }
    } else {
      console.warn('[CallManager] navigator.mediaDevices unavailable (requires localhost or HTTPS)');
      if (statusEl) statusEl.textContent = 'Calling (No microphone on HTTP)';
    }

    if (statusEl && statusEl.textContent === 'Calling…') {
      statusEl.textContent = 'Ringing…';
    }

    // 3. Broadcast Call Signal to Peer(s)
    const callId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    let callerPeerId = (typeof P2PSync !== 'undefined' && P2PSync.getPeer()) ? P2PSync.getPeer().id : '';
    if (!callerPeerId && session?.role === 'owner') {
      const cleanId = String(roomId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
      callerPeerId = `pchat_h_${cleanId}`;
    }

    const invitePayload = {
      action: 'invite',
      callId,
      roomId,
      callerId: session?.memberId || 'me',
      callerName: session?.displayName || 'Caller',
      callerPicture: session?.picture || '',
      callerPeerId,
      callType: _callType,
      timestamp: Date.now()
    };

    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
      P2PSync.broadcastCallSignal(invitePayload);
    }

    // 4. Initiate PeerJS Media Call to peer(s) if localStream is available
    const peer = (typeof P2PSync !== 'undefined') ? P2PSync.getPeer() : null;
    if (peer && !peer.destroyed && _localStream) {
      if (session?.role !== 'owner') {
        const cleanId = String(roomId).replace(/[^a-zA-Z0-9]/g, '').slice(0, 24);
        const hostPeerId = `pchat_h_${cleanId}`;
        try {
          const mediaConn = peer.call(hostPeerId, _localStream, { metadata: { callType: _callType, callerName: session?.displayName } });
          _setupMediaConnection(mediaConn);
        } catch (e) {
          console.warn('[CallManager] Direct peer call error:', e);
        }
      } else if (typeof P2PSync !== 'undefined' && P2PSync.getConnectedPeerIds) {
        const guestPeerIds = P2PSync.getConnectedPeerIds();
        guestPeerIds.forEach(gId => {
          try {
            const mediaConn = peer.call(gId, _localStream, { metadata: { callType: _callType, callerName: session?.displayName } });
            _setupMediaConnection(mediaConn);
          } catch (e) {
            console.warn('[CallManager] Host call to guest error:', e);
          }
        });
      }
    }

    // 45s Timeout for No Answer
    setTimeout(() => {
      if (_callState === 'calling') {
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'No Answer';
        setTimeout(() => endCall(), 2000);
      }
    }, 45000);
  }

  // ── Handle Incoming Signal ──────────────────────────────────────
  function handleIncomingSignal(payload) {
    if (!payload || !payload.action) return;
    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    const myId = session?.memberId;

    if (payload.callerId === myId) return; // ignore our own signals

    if (payload.action === 'invite') {
      if (_callState !== 'idle') {
        // Send busy signal back
        if (typeof P2PSync !== 'undefined') {
          P2PSync.broadcastCallSignal({ action: 'busy', callId: payload.callId, fromId: myId });
        }
        return;
      }

      _incomingCallData = payload;
      _callType = payload.callType || 'audio';
      _callState = 'incoming';

      _ensureUIElements();
      _showIncomingToast(payload);
      _playIncomingRing();
    } else if (payload.action === 'accept') {
      if (_callState === 'calling') {
        _stopSounds();
        _playConnectedChime();
        _callState = 'connected';
        const st = document.getElementById('call-status-subtitle');
        if (st) st.textContent = 'Connected';
        _startCallTimer();

        if (_pendingMediaConnection && _localStream) {
          try {
            _pendingMediaConnection.answer(_localStream);
            _setupMediaConnection(_pendingMediaConnection);
          } catch (e) {
            console.warn('[CallManager] Error answering pending call on accept:', e);
          }
          _pendingMediaConnection = null;
        }
      }
    } else if (payload.action === 'decline') {
      if (_callState === 'calling') {
        document.getElementById('call-status-subtitle').textContent = 'Call Declined';
        _stopSounds();
        _playEndChime();
        setTimeout(() => endCall(), 1600);
      }
    } else if (payload.action === 'end') {
      if (_callState !== 'idle') {
        endCall(false);
      }
    } else if (payload.action === 'busy') {
      if (_callState === 'calling') {
        document.getElementById('call-status-subtitle').textContent = 'User is Busy';
        _stopSounds();
        _playEndChime();
        setTimeout(() => endCall(), 2000);
      }
    }
  }

  // ── Accept Incoming Call ────────────────────────────────────────
  async function acceptCall() {
    if (!_incomingCallData) return;
    _stopSounds();
    _hideIncomingToast();

    _callType = _incomingCallData.callType || 'audio';

    try {
      const constraints = {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: (_callType === 'video') ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
      };
      _localStream = await navigator.mediaDevices.getUserMedia(constraints);
    } catch {
      try {
        _localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        _callType = 'audio';
      } catch {
        if (typeof UI !== 'undefined') UI.toast('error', 'Error', 'Cannot access audio device.');
        declineCall();
        return;
      }
    }

    _callState = 'connected';
    _isMuted = false;
    _isVideoOff = false;

    _showCallOverlay();
    document.getElementById('call-peer-name').textContent = _incomingCallData.callerName || 'Room Member';
    document.getElementById('call-status-subtitle').textContent = 'Connected';

    const localVideo = document.getElementById('call-local-video');
    if (localVideo && _callType === 'video') {
      localVideo.srcObject = _localStream;
    }

    _playConnectedChime();
    _startCallTimer();

    // Broadcast accept signal
    const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
    if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
      P2PSync.broadcastCallSignal({
        action: 'accept',
        callId: _incomingCallData.callId,
        fromId: session?.memberId || 'guest'
      });
    }

    // Answer incoming PeerJS media call if received
    if (_pendingMediaConnection) {
      _pendingMediaConnection.answer(_localStream);
      _setupMediaConnection(_pendingMediaConnection);
      _pendingMediaConnection = null;
    } else if (_incomingCallData.callerPeerId) {
      // Connect call directly to caller's peer ID
      const peer = (typeof P2PSync !== 'undefined') ? P2PSync.getPeer() : null;
      if (peer && !peer.destroyed) {
        try {
          const mediaConn = peer.call(_incomingCallData.callerPeerId, _localStream, { metadata: { callType: _callType } });
          _setupMediaConnection(mediaConn);
        } catch (e) {
          console.warn('[CallManager] Answer call error:', e);
        }
      }
    }
  }

  // ── Decline Call ────────────────────────────────────────────────
  function declineCall() {
    _stopSounds();
    _hideIncomingToast();

    if (_incomingCallData) {
      const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
        P2PSync.broadcastCallSignal({
          action: 'decline',
          callId: _incomingCallData.callId,
          fromId: session?.memberId || 'guest'
        });
      }
      _incomingCallData = null;
    }

    if (_pendingMediaConnection) {
      try { _pendingMediaConnection.close(); } catch {}
      _pendingMediaConnection = null;
    }

    _callState = 'idle';
  }

  // ── Setup MediaConnection Listeners ─────────────────────────────
  function _setupMediaConnection(conn) {
    if (!conn) return;
    _activeCall = conn;

    conn.on('stream', (remoteStream) => {
      console.log('[CallManager] Remote stream received:', remoteStream.id);
      _remoteStream = remoteStream;

      _stopSounds();
      _playConnectedChime();
      _callState = 'connected';
      document.getElementById('call-status-subtitle').textContent = 'Connected';
      _startCallTimer();

      const remoteAudio = document.getElementById('call-remote-audio');
      if (remoteAudio) {
        remoteAudio.srcObject = remoteStream;
        remoteAudio.play().catch(() => {});
      }

      const remoteVideo = document.getElementById('call-remote-video');
      if (remoteVideo) {
        remoteVideo.srcObject = remoteStream;
        remoteVideo.play().catch(() => {});
      }

      // Attach audio analyzer for voice visualizer
      _setupAudioVisualizer(remoteStream);
    });

    conn.on('close', () => {
      console.log('[CallManager] MediaConnection closed.');
      endCall(false);
    });

    conn.on('error', (err) => {
      console.warn('[CallManager] MediaConnection error:', err);
    });
  }

  // ── End Active Call ─────────────────────────────────────────────
  function endCall(sendSignal = true) {
    _stopSounds();
    _playEndChime();
    _stopCallTimer();
    _stopVisualizer();

    if (sendSignal) {
      const session = (typeof Storage !== 'undefined') ? Storage.getSession() : null;
      if (typeof P2PSync !== 'undefined' && P2PSync.broadcastCallSignal) {
        P2PSync.broadcastCallSignal({
          action: 'end',
          fromId: session?.memberId || 'guest'
        });
      }
    }

    // Stop local tracks
    if (_localStream) {
      _localStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      _localStream = null;
    }
    if (_screenStream) {
      _screenStream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      _screenStream = null;
    }

    // Close PeerJS call
    if (_activeCall) {
      try { _activeCall.close(); } catch {}
      _activeCall = null;
    }
    _pendingMediaConnection = null;

    _callState = 'idle';
    _incomingCallData = null;
    _isMinimized = false;

    _hideCallOverlay();
    _hideIncomingToast();
  }

  // ── Controls: Mute, Camera, Screen Share ────────────────────────
  function toggleMic() {
    if (!_localStream) return;
    const audioTrack = _localStream.getAudioTracks()[0];
    if (audioTrack) {
      _isMuted = !_isMuted;
      audioTrack.enabled = !_isMuted;

      const btn = document.getElementById('call-dock-mic');
      const micOn = document.getElementById('icon-mic-on');
      const micOff = document.getElementById('icon-mic-off');

      if (btn) btn.classList.toggle('is-off', _isMuted);
      if (micOn) micOn.classList.toggle('hidden', _isMuted);
      if (micOff) micOff.classList.toggle('hidden', !_isMuted);
    }
  }

  function toggleCamera() {
    if (!_localStream) return;
    const videoTrack = _localStream.getVideoTracks()[0];

    if (videoTrack) {
      _isVideoOff = !_isVideoOff;
      videoTrack.enabled = !_isVideoOff;

      const btn = document.getElementById('call-dock-cam');
      const camOn = document.getElementById('icon-cam-on');
      const camOff = document.getElementById('icon-cam-off');

      if (btn) btn.classList.toggle('is-off', _isVideoOff);
      if (camOn) camOn.classList.toggle('hidden', _isVideoOff);
      if (camOff) camOff.classList.toggle('hidden', !_isVideoOff);
    } else if (_callType === 'audio') {
      // Upgrade audio call to video call on the fly!
      navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } })
        .then(newStream => {
          const newVideoTrack = newStream.getVideoTracks()[0];
          _localStream.addTrack(newVideoTrack);
          _callType = 'video';
          _updateStageDisplay();

          const localVideo = document.getElementById('call-local-video');
          if (localVideo) localVideo.srcObject = _localStream;

          // Replace track in active peer connection
          if (_activeCall && _activeCall.peerConnection) {
            const sender = _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
              sender.replaceTrack(newVideoTrack);
            } else {
              _activeCall.peerConnection.addTrack(newVideoTrack, _localStream);
            }
          }
        })
        .catch(err => {
          console.warn('[CallManager] Cannot add camera:', err);
        });
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

      if (_localStream) {
        const camTrack = _localStream.getVideoTracks()[0];
        if (camTrack && _activeCall && _activeCall.peerConnection) {
          const sender = _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
          if (sender) sender.replaceTrack(camTrack);
        }
        const localVideo = document.getElementById('call-local-video');
        if (localVideo) localVideo.srcObject = _localStream;
      }
      return;
    }

    try {
      _screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const screenTrack = _screenStream.getVideoTracks()[0];
      _isScreenSharing = true;
      document.getElementById('call-dock-screen')?.classList.add('is-active');

      // Auto-revert when user clicks "Stop sharing" in browser banner
      screenTrack.onended = () => {
        toggleScreenShare();
      };

      if (_activeCall && _activeCall.peerConnection) {
        const sender = _activeCall.peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
          sender.replaceTrack(screenTrack);
        } else {
          _activeCall.peerConnection.addTrack(screenTrack, _screenStream);
        }
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
      _isScreenSharing = false;
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
    if (overlay) overlay.style.display = 'flex';
  }

  function _hideCallOverlay() {
    const overlay = document.getElementById('active-call-overlay');
    if (overlay) overlay.style.display = 'none';
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
      if (data.callerPicture && /^(data:|https?:)/i.test(data.callerPicture)) {
        av.innerHTML = `<img src="${data.callerPicture}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;" />`;
      } else {
        av.textContent = (data.callerName ? data.callerName[0] : '?').toUpperCase();
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
    console.log('[CallManager] Handling incoming PeerJS MediaConnection:', mediaConn.peer);
    if ((_callState === 'connected' || _callState === 'calling') && _localStream) {
      // If we already accepted the call or are in outgoing calling state, answer immediately
      try {
        mediaConn.answer(_localStream);
        _setupMediaConnection(mediaConn);
      } catch (e) {
        console.warn('[CallManager] Error answering incoming media call:', e);
      }
    } else {
      // Store connection until user clicks "Accept"
      _pendingMediaConnection = mediaConn;
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
        setTimeout(() => startCall(autoCall), 600);
      }
    } catch {}

    // Preload call ringtone
    try {
      const preload = new Audio(CALL_SOUND_SRC);
      preload.preload = 'auto';
    } catch {}
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
