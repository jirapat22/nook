// VoiceRecorder — wraps MediaRecorder + keyword detection ("done")
// Handles iOS Safari quirks (no timeslice, limited codec support)

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

export class VoiceRecorder {
  constructor({ onStart, onStop, onKeyword } = {}) {
    this.onStart   = onStart   || (() => {});
    this.onStop    = onStop    || (() => {});
    this.onKeyword = onKeyword || (() => {});

    this.mediaRecorder  = null;
    this.stream         = null;
    this.chunks         = [];
    this.isRecording    = false;
    this.recognition    = null;
    this._stopTimeout   = null;
  }

  async start() {
    if (this.isRecording) return;
    try {
      // Audio constraints noticeably improve Whisper transcription quality.
      // Fallback to plain `audio: true` if constraints are rejected by old browsers.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      }).catch(() => navigator.mediaDevices.getUserMedia({ audio: true }));
    } catch (err) {
      const msg = err.name === 'NotAllowedError'
        ? 'Microphone permission denied. Open Settings > Safari > Microphone (or your browser settings) to allow it.'
        : 'Could not access microphone: ' + err.message;
      // Surface to UI via callback instead of blocking alert()
      this.onStop(new Blob([], { type: 'audio/mp4' }));
      this._lastError = msg;
      return;
    }

    this.chunks = [];
    this._onStopFired = false; // reset for each recording
    const mimeType = getSupportedMimeType();
    const options  = mimeType ? { mimeType } : {};

    try {
      this.mediaRecorder = new MediaRecorder(this.stream, options);
    } catch (e) {
      // Fallback: try without options (let browser pick)
      this.mediaRecorder = new MediaRecorder(this.stream);
    }

    this.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      clearTimeout(this._stopTimeout);
      if (this._onStopFired) return; // already fired via _forceStop
      this._onStopFired = true;
      const actualMime = this.mediaRecorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type: actualMime });
      this.chunks = [];
      this.onStop(blob);
    };

    this.mediaRecorder.onerror = (e) => {
      console.error('MediaRecorder error:', e);
      this._forceStop();
    };

    // iOS doesn't support timeslice reliably — use start() with no argument,
    // but flush chunks every 30s with requestData() so long recordings don't
    // accumulate in an internal buffer that can drop on memory pressure.
    // Desktop: 1s timeslice (250ms made 720+ chunks for a 3-min entry → wasteful)
    if (isIOS) {
      this.mediaRecorder.start();
      this._iosFlushInterval = setInterval(() => {
        if (this.mediaRecorder?.state === 'recording') {
          try { this.mediaRecorder.requestData(); } catch {}
        }
      }, 30000);
    } else {
      this.mediaRecorder.start(1000);
    }

    this.isRecording = true;
    this.onStart();
    this.startKeywordDetection();
  }

  async stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.stopKeywordDetection();
    clearInterval(this._iosFlushInterval);

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Set a timeout in case onstop never fires (iOS bug)
      this._stopTimeout = setTimeout(() => {
        console.warn('VoiceRecorder: onstop timeout, forcing stop');
        this._forceStop();
      }, 4000);

      try {
        // On iOS: request data and wait briefly for ondataavailable to fire
        // before calling stop. Without this small gap iOS Safari sometimes
        // drops the final chunk entirely → 0-byte blob → "no audio captured".
        if (isIOS && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.requestData();
          await new Promise(r => setTimeout(r, 250));
        }
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn('mediaRecorder.stop() error:', e);
        this._forceStop();
      }
    } else {
      this._forceStop();
    }

    // Stop mic tracks AFTER a tick — stopping them synchronously could
    // cut the stream before MediaRecorder finishes flushing on some browsers.
    const stream = this.stream;
    this.stream = null;
    setTimeout(() => stream?.getTracks().forEach(t => t.stop()), 500);
  }

  _forceStop() {
    clearTimeout(this._stopTimeout);
    if (this._onStopFired) return; // already fired — never double-call onStop
    this._onStopFired = true;
    // Use the real mime if we know it, not always mp4
    const mimeFromRec = this.mediaRecorder?.mimeType;
    const type = mimeFromRec || 'audio/mp4';
    if (this.chunks.length > 0) {
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      this.onStop(blob);
    } else {
      this.onStop(new Blob([], { type }));
    }
  }

  startKeywordDetection() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) return;

    try {
      this.recognition = new SR();
      this.recognition.continuous     = true;
      this.recognition.interimResults = true;
      this.recognition.lang           = 'en-US';

      this.recognition.onresult = event => {
        if (!this.isRecording) return;
        // Only stop on the EXACT phrase "stop recording" — single words like
        // "done" or "stop" matched too aggressively (e.g. "I'm done with the
        // meeting" or "I had to stop and think" killed long entries mid-thought)
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript.toLowerCase().trim();
          // Match phrase with word boundaries — "stop recording" anywhere in the segment
          if (/\bstop recording\b/.test(text)) {
            this.onKeyword();
            break;
          }
        }
      };

      this.recognition.onerror = () => { /* ignore — mic already granted */ };

      this.recognition.onend = () => {
        // Restart only if still actively recording
        if (this.isRecording && this.recognition) {
          try { this.recognition.start(); } catch {}
        }
      };

      this.recognition.start();
    } catch (e) {
      // Speech recognition not available — that's fine, mic tap still works
      this.recognition = null;
    }
  }

  stopKeywordDetection() {
    if (this.recognition) {
      try { this.recognition.abort(); } catch {}
      this.recognition = null;
    }
  }

  destroy() {
    this.isRecording = false;
    this._onStopFired = true; // suppress any in-flight onstop callback after destroy
    this.stopKeywordDetection();
    clearTimeout(this._stopTimeout);
    clearInterval(this._iosFlushInterval);
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try { this.mediaRecorder.stop(); } catch {}
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }
}

function getSupportedMimeType() {
  const types = [
    'audio/mp4',                  // iOS Safari — must be first for iOS
    'audio/webm;codecs=opus',     // Chrome/Android
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported(type)) return type;
    } catch {}
  }
  return '';
}
