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
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        alert('Microphone permission denied. Please allow microphone access in your browser settings and try again.');
      } else {
        alert('Could not access microphone: ' + err.message);
      }
      return;
    }

    this.chunks = [];
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
      const actualMime = this.mediaRecorder.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type: actualMime });
      this.chunks = [];
      this.onStop(blob);
    };

    this.mediaRecorder.onerror = (e) => {
      console.error('MediaRecorder error:', e);
      this._forceStop();
    };

    // iOS doesn't support timeslice reliably — use start() with no argument
    // Desktop: collect in 250ms chunks for smoother waveform
    if (isIOS) {
      this.mediaRecorder.start();
    } else {
      this.mediaRecorder.start(250);
    }

    this.isRecording = true;
    this.onStart();
    this.startKeywordDetection();
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.stopKeywordDetection();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Set a timeout in case onstop never fires (iOS bug)
      this._stopTimeout = setTimeout(() => {
        console.warn('VoiceRecorder: onstop timeout, forcing stop');
        this._forceStop();
      }, 4000);

      try {
        // On iOS: request data before stopping to ensure we get it
        if (isIOS && this.mediaRecorder.state === 'recording') {
          this.mediaRecorder.requestData();
        }
        this.mediaRecorder.stop();
      } catch (e) {
        console.warn('mediaRecorder.stop() error:', e);
        this._forceStop();
      }
    } else {
      this._forceStop();
    }

    // Stop the mic stream tracks
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  _forceStop() {
    clearTimeout(this._stopTimeout);
    // If onstop never fired, call onStop with whatever we have
    if (this.chunks.length > 0) {
      const blob = new Blob(this.chunks, { type: 'audio/mp4' });
      this.chunks = [];
      this.onStop(blob);
    } else {
      // Nothing recorded — call onStop with empty blob so UI can recover
      this.onStop(new Blob([], { type: 'audio/mp4' }));
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
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const text = event.results[i][0].transcript.toLowerCase().trim();
          if (text.includes('done') || text.includes('stop recording') || text.includes('stop')) {
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
    this.stopKeywordDetection();
    clearTimeout(this._stopTimeout);
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
