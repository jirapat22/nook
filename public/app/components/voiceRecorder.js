// VoiceRecorder — wraps MediaRecorder + keyword detection ("done")

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
  }

  async start() {
    if (this.isRecording) return;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      if (err.name === 'NotAllowedError') {
        alert('Microphone permission denied. Please allow microphone access and try again.');
      } else {
        alert('Could not access microphone: ' + err.message);
      }
      return;
    }

    this.chunks = [];
    const mimeType = getSupportedMimeType();
    const options  = mimeType ? { mimeType } : {};

    this.mediaRecorder = new MediaRecorder(this.stream, options);
    this.mediaRecorder.ondataavailable = e => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.onstop = () => {
      const blob = new Blob(this.chunks, { type: mimeType || 'audio/webm' });
      this.chunks = [];
      this.onStop(blob);
    };

    this.mediaRecorder.start(250); // collect data every 250ms
    this.isRecording = true;
    this.onStart();

    // Keyword detection via SpeechRecognition
    this.startKeywordDetection();
  }

  stop() {
    if (!this.isRecording) return;
    this.isRecording = false;
    this.stopKeywordDetection();

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
  }

  startKeywordDetection() {
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) return;
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.recognition = new SR();
    this.recognition.continuous     = true;
    this.recognition.interimResults = true;
    this.recognition.lang           = 'en-US';

    this.recognition.onresult = event => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript.toLowerCase().trim();
        if (transcript.includes('done') || transcript.includes('stop recording')) {
          this.onKeyword();
          break;
        }
      }
    };

    this.recognition.onerror = () => {
      // Silently ignore recognition errors (permission already granted for MediaRecorder)
    };

    this.recognition.onend = () => {
      // Restart if still recording (recognition stops after ~60s of silence)
      if (this.isRecording) {
        try { this.recognition.start(); } catch {}
      }
    };

    try { this.recognition.start(); } catch {}
  }

  stopKeywordDetection() {
    try { this.recognition?.stop(); } catch {}
    this.recognition = null;
  }

  destroy() {
    this.stop();
  }
}

function getSupportedMimeType() {
  const types = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
    'audio/mp4',
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}
