/*
 * RigLingo v1.1.1 - live two-way voice translation for ham radio
 * By Kathryn Mullan
 *
 * ES5 only (no let/const, arrow functions, template literals or classes).
 * Heavy speech models run in worker.js.
 *
 * Sections
 *   1. Constants & languages
 *   2. Settings
 *   3. DOM helpers & log
 *   4. Browser check
 *   5. Speech worker bridge
 *   6. Translation (Chrome on-device Translator / Language Detector)
 *   7. Audio capture, devices & playback
 *   8. Voices (neural MMS or system voice)
 *   9. Radio connection (Web Serial: CAT / RTS / DTR / VOX)
 *  10. Receive pipeline (voice trigger -> Whisper -> translate -> speak)
 *  11. Transmit pipeline (talk -> Whisper -> translate -> review -> key & play)
 *  12. Station ID
 *  13. UI wiring & start-up
 */
(function () {
  'use strict';

  /* =========================================================
   * 1. Constants & languages
   * ========================================================= */
  var VERSION = '1.1.1';
  var SAMPLE_RATE = 16000;
  var FRAME = 2048;                       // samples per audio frame (128 ms)
  var FRAME_SEC = FRAME / SAMPLE_RATE;
  var MAX_SEG_SEC = 28;                   // Whisper window is 30 s
  var MIN_SEG_SEC = 0.6;
  var PREROLL_FRAMES = 3;

  // mms: Transformers.js neural voice that can be routed to the radio.
  // Only Latin-script languages get one; the rest use a system voice.
  var LANGS = [
    { code: 'en', name: 'English',    whisper: 'english',    mms: 'Xenova/mms-tts-eng', bcp: 'en-US' },
    { code: 'fr', name: 'French',     whisper: 'french',     mms: 'Xenova/mms-tts-fra', bcp: 'fr-FR' },
    { code: 'es', name: 'Spanish',    whisper: 'spanish',    mms: 'Xenova/mms-tts-spa', bcp: 'es-ES' },
    { code: 'de', name: 'German',     whisper: 'german',     mms: 'Xenova/mms-tts-deu', bcp: 'de-DE' },
    { code: 'it', name: 'Italian',    whisper: 'italian',    mms: 'Xenova/mms-tts-ita', bcp: 'it-IT' },
    { code: 'pt', name: 'Portuguese', whisper: 'portuguese', mms: 'Xenova/mms-tts-por', bcp: 'pt-BR' },
    { code: 'nl', name: 'Dutch',      whisper: 'dutch',      mms: 'Xenova/mms-tts-nld', bcp: 'nl-NL' },
    { code: 'pl', name: 'Polish',     whisper: 'polish',     mms: 'Xenova/mms-tts-pol', bcp: 'pl-PL' },
    { code: 'ru', name: 'Russian',    whisper: 'russian',    mms: null, bcp: 'ru-RU' },
    { code: 'uk', name: 'Ukrainian',  whisper: 'ukrainian',  mms: null, bcp: 'uk-UA' },
    { code: 'ja', name: 'Japanese',   whisper: 'japanese',   mms: null, bcp: 'ja-JP' },
    { code: 'zh', name: 'Chinese',    whisper: 'chinese',    mms: null, bcp: 'zh-CN' },
    { code: 'ko', name: 'Korean',     whisper: 'korean',     mms: null, bcp: 'ko-KR' },
    { code: 'ar', name: 'Arabic',     whisper: 'arabic',     mms: null, bcp: 'ar-SA' },
    { code: 'hi', name: 'Hindi',      whisper: 'hindi',      mms: null, bcp: 'hi-IN' },
    { code: 'tr', name: 'Turkish',    whisper: 'turkish',    mms: null, bcp: 'tr-TR' }
  ];

  var DIGITS = {
    en: ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'],
    fr: ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf'],
    es: ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve'],
    de: ['null', 'eins', 'zwei', 'drei', 'vier', 'fünf', 'sechs', 'sieben', 'acht', 'neun'],
    it: ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'],
    pt: ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove'],
    nl: ['nul', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'zeven', 'acht', 'negen'],
    pl: ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć']
  };

  var PHONETIC = {
    A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta', E: 'Echo', F: 'Foxtrot', G: 'Golf',
    H: 'Hotel', I: 'India', J: 'Juliet', K: 'Kilo', L: 'Lima', M: 'Mike', N: 'November',
    O: 'Oscar', P: 'Papa', Q: 'Quebec', R: 'Romeo', S: 'Sierra', T: 'Tango', U: 'Uniform',
    V: 'Victor', W: 'Whiskey', X: 'X ray', Y: 'Yankee', Z: 'Zulu',
    '0': 'Zero', '1': 'One', '2': 'Two', '3': 'Three', '4': 'Four', '5': 'Five',
    '6': 'Six', '7': 'Seven', '8': 'Eight', '9': 'Niner', '/': 'stroke'
  };

  var MODES = {
    '1': 'LSB', '2': 'USB', '3': 'CW', '4': 'FM', '5': 'AM', '6': 'RTTY-L', '7': 'CW-R',
    '8': 'DATA-L', '9': 'RTTY-U', 'A': 'DATA-FM', 'B': 'FM-N', 'C': 'DATA-U', 'D': 'AM-N', 'E': 'C4FM'
  };

  // Phrases Whisper tends to invent from pure noise
  var HALLUCINATIONS = [
    /^\W*$/,
    /^(thank you|thanks)( (so|very) much)?( for (watching|listening))?\W*$/i,
    /^(you|bye|okay|ok)\W*$/i,
    /subtitles? (by|from)/i,
    /amara\.org/i,
    /^(merci|sous-titr)/i,
    /^♪/
  ];

  function langByCode(code) {
    for (var i = 0; i < LANGS.length; i++) {
      if (LANGS[i].code === code) { return LANGS[i]; }
    }
    return null;
  }
  function langName(code) {
    var l = langByCode(code);
    return l ? l.name : (code ? code.toUpperCase() : 'Unknown');
  }

  /* =========================================================
   * 2. Settings
   * ========================================================= */
  var STORE_KEY = 'riglingo.settings.v1';
  var settings = {
    pttMethod: 'cat', baud: '4800', stopBits: '2', flow: 'none', onlyYaesu: true,
    devRadioIn: '', devRadioOut: '', devMicIn: '', devLocalOut: '',
    sens: 8, hang: 1.2, txGain: 60,
    theirLang: 'fr', myLang: 'en', asrModel: 'onnx-community/whisper-base',
    callsign: '', idMode: '10min', reviewTx: true, speakRx: true, showOriginal: true,
    leadIn: 300, txTimeout: 90
  };

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (raw) {
        var saved = JSON.parse(raw);
        for (var k in saved) {
          if (saved.hasOwnProperty(k) && settings.hasOwnProperty(k)) { settings[k] = saved[k]; }
        }
      }
    } catch (e) { /* storage unavailable */ }
  }
  function saveSettings() {
    try { window.localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
  }

  /* =========================================================
   * 3. DOM helpers & log
   * ========================================================= */
  function $(id) { return document.getElementById(id); }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) { n.className = cls; }
    if (text !== undefined && text !== null) { n.textContent = text; }
    return n;
  }

  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function timeStamp() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + 'Z';
  }

  var LAMP_TEXT = {
    lampRig: { '': 'Radio not connected', on: 'Radio connected', err: 'Radio problem' },
    lampAI: { '': 'Models not loaded', busy: 'Loading models…', on: 'Models ready', err: 'Model problem' },
    lampRX: { '': 'Not listening', on: 'Listening', busy: 'Hearing a signal' },
    lampTX: { '': 'On air', on: 'On air' }
  };

  function setLamp(id, state) {
    var n = $(id);
    state = state || '';
    n.className = 'chip' + (id === 'lampTX' ? ' chip-tx' : '') + (state ? ' ' + state : '');
    if (LAMP_TEXT[id] && LAMP_TEXT[id][state]) { n.textContent = LAMP_TEXT[id][state]; }
    if (id === 'lampTX') { n.hidden = state !== 'on'; }
  }

  var bannerTimer = null;
  function banner(msg, kind, ms) {
    var b = $('banner');
    if (!msg) { b.hidden = true; return; }
    b.textContent = msg;
    b.className = 'banner' + (kind === 'info' ? ' info' : '');
    b.hidden = false;
    if (bannerTimer) { clearTimeout(bannerTimer); }
    if (ms) { bannerTimer = setTimeout(function () { b.hidden = true; }, ms); }
  }

  // Log entry: kind = rx | tx | sys | err
  function addEntry(kind, mainText, opts) {
    opts = opts || {};
    var empty = $('logEmpty');
    if (empty) { empty.parentNode.removeChild(empty); }
    var box = el('div', 'entry ' + kind + (opts.working ? ' working' : ''));
    var who = kind === 'rx' ? 'Heard' : kind === 'tx' ? 'You' : '';
    var meta = el('div', 'meta', who + ', ' + timeStamp() + (rig.freqText ? ', ' + rig.freqText + ' MHz' : ''));
    var badge = el('span', 'badge', opts.badge || '');
    if (!opts.badge) { badge.style.display = 'none'; }
    meta.appendChild(badge);
    var orig = el('div', 'orig', '');
    orig.style.display = 'none';
    var main = el('div', 'main', mainText);
    var actions = el('div', 'actions');
    actions.style.display = 'none';
    box.appendChild(meta);
    box.appendChild(orig);
    box.appendChild(main);
    box.appendChild(actions);
    var log = $('log');
    log.appendChild(box);
    log.scrollTop = log.scrollHeight;

    var api = {
      node: box,
      set: function (text, working) {
        main.textContent = text;
        if (working) { box.className = 'entry ' + kind + ' working'; } else { box.className = 'entry ' + kind; }
        log.scrollTop = log.scrollHeight;
      },
      orig: function (text) {
        if (text && settings.showOriginal) { orig.textContent = text; orig.style.display = ''; }
        else { orig.style.display = 'none'; }
      },
      badge: function (text) {
        badge.textContent = text || '';
        badge.style.display = text ? '' : 'none';
      },
      action: function (label, fn) {
        var b = el('button', null, label);
        b.addEventListener('click', fn);
        actions.appendChild(b);
        actions.style.display = '';
      },
      remove: function () { if (box.parentNode) { box.parentNode.removeChild(box); } }
    };
    return api;
  }
  function sysLog(text) { return addEntry('sys', text); }
  function errLog(text) { return addEntry('err', text); }

  /* =========================================================
   * 4. Browser check
   * ========================================================= */
  var caps = {};

  function runChecks() {
    caps.secure = window.isSecureContext === true;
    caps.serial = 'serial' in navigator;
    caps.gpu = 'gpu' in navigator;
    caps.translator = typeof window.Translator !== 'undefined';
    caps.detector = typeof window.LanguageDetector !== 'undefined';
    caps.sink = typeof AudioContext !== 'undefined' && typeof AudioContext.prototype.setSinkId === 'function';
    caps.media = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    var list = $('checks');
    list.innerHTML = '';
    function item(cls, text) { list.appendChild(el('li', cls, text)); }
    item(caps.secure ? 'ok' : 'bad', caps.secure ? 'Secure page (https)' : 'Needs https or localhost');
    item(caps.media ? 'ok' : 'bad', 'Microphone / audio capture');
    item(caps.sink ? 'ok' : 'bad', caps.sink ? 'Audio output routing' : 'Audio output routing missing (Chrome/Edge 110+)');
    item(caps.serial ? 'ok' : 'warn', caps.serial ? 'Web Serial (CAT / PTT)' : 'No Web Serial – VOX keying only');
    item(caps.gpu ? 'ok' : 'warn', caps.gpu ? 'WebGPU (fast speech recognition)' : 'No WebGPU – slower CPU recognition');
    item(caps.translator ? 'ok' : 'bad', caps.translator ? 'On-device translator' : 'No on-device translator (Chrome 138+ desktop)');
    item(caps.detector ? 'ok' : 'warn', caps.detector ? 'Language auto-detect' : 'No language auto-detect');
  }

  /* =========================================================
   * 5. Speech worker bridge
   * ========================================================= */
  var worker = null;
  var rpcSeq = 0;
  var rpcPending = {};
  var ai = { asrReady: false, asrModel: '', device: '', loadingAsr: null };

  function startWorker() {
    try {
      worker = new Worker('worker.js', { type: 'module' });
    } catch (e) {
      setLamp('lampAI', 'err');
      errLog('Could not start the speech engine: ' + e.message);
      return;
    }
    worker.onmessage = function (e) {
      var m = e.data || {};
      if (m.type === 'ready') { return; }
      var p = rpcPending[m.id];
      if (!p) { return; }
      if (m.type === 'progress') { if (p.onProgress) { p.onProgress(m); } return; }
      delete rpcPending[m.id];
      if (m.type === 'error') { p.reject(new Error(m.error)); } else { p.resolve(m); }
    };
    worker.onerror = function (e) {
      setLamp('lampAI', 'err');
      errLog('Speech engine failed to load (' + (e.message || 'network?') + '). It needs an internet connection the first time.');
      for (var id in rpcPending) {
        if (rpcPending.hasOwnProperty(id)) { rpcPending[id].reject(new Error('Speech engine unavailable')); }
      }
      rpcPending = {};
    };
  }

  function rpc(msg, onProgress) {
    return new Promise(function (resolve, reject) {
      if (!worker) { reject(new Error('Speech engine not running')); return; }
      var id = ++rpcSeq;
      msg.id = id;
      rpcPending[id] = { resolve: resolve, reject: reject, onProgress: onProgress };
      var transfer = msg.audio ? [msg.audio.buffer] : [];
      worker.postMessage(msg, transfer);
    });
  }

  function showProgress(m) {
    var wrap = $('prepProgress');
    wrap.hidden = false;
    if (typeof m.progress === 'number') { $('prepFill').style.width = Math.max(2, Math.min(100, m.progress)) + '%'; }
  }

  function ensureASR() {
    if (ai.asrReady && ai.asrModel === settings.asrModel) { return Promise.resolve(); }
    if (ai.loadingAsr) { return ai.loadingAsr; }
    setLamp('lampAI', 'busy');
    ai.loadingAsr = rpc({ type: 'load-asr', model: settings.asrModel }, showProgress).then(function (m) {
      ai.asrReady = true;
      ai.asrModel = settings.asrModel;
      ai.device = m.device;
      ai.loadingAsr = null;
      setLamp('lampAI', 'on');
      $('prepProgress').hidden = true;
    }, function (err) {
      ai.loadingAsr = null;
      setLamp('lampAI', 'err');
      throw err;
    });
    return ai.loadingAsr;
  }

  function transcribe(audio, whisperLang, task) {
    return ensureASR().then(function () {
      return rpc({ type: 'asr', model: settings.asrModel, audio: audio, language: whisperLang || null, task: task || 'transcribe' });
    }).then(function (m) { return m.text || ''; });
  }

  function cleanTranscript(text) {
    var t = (text || '').replace(/\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ');
    t = t.replace(/^\s+|\s+$/g, '');
    for (var i = 0; i < HALLUCINATIONS.length; i++) {
      if (HALLUCINATIONS[i].test(t)) { return ''; }
    }
    return t;
  }

  /* =========================================================
   * 6. Translation
   * ========================================================= */
  var translators = {};
  var detector = null;

  function getTranslator(src, tgt) {
    var key = src + '>' + tgt;
    if (translators[key]) { return Promise.resolve(translators[key]); }
    if (!caps.translator) { return Promise.reject(new Error('This browser has no on-device translator (needs Chrome 138+ on desktop).')); }
    return window.Translator.availability({ sourceLanguage: src, targetLanguage: tgt }).then(function (a) {
      if (a === 'unavailable') { throw new Error(langName(src) + ' → ' + langName(tgt) + ' is not supported by the on-device translator.'); }
      return window.Translator.create({
        sourceLanguage: src,
        targetLanguage: tgt,
        monitor: function (mon) {
          mon.addEventListener('downloadprogress', function (e) {
            showProgress({ progress: Math.round((e.loaded || 0) * 100) });
          });
        }
      });
    }).then(function (t) {
      translators[key] = t;
      return t;
    }, function (err) {
      if (err && err.name === 'NotAllowedError') {
        throw new Error('The ' + langName(src) + ' → ' + langName(tgt) + ' language pack needs to download. Click "Download & prepare" first.');
      }
      throw err;
    });
  }

  function translate(src, tgt, text) {
    if (!text || src === tgt) { return Promise.resolve(text); }
    return getTranslator(src, tgt).then(function (t) { return t.translate(text); });
  }

  function getDetector() {
    if (detector) { return Promise.resolve(detector); }
    if (!caps.detector) { return Promise.resolve(null); }
    return window.LanguageDetector.create().then(function (d) { detector = d; return d; }, function () { return null; });
  }

  function detectLang(text) {
    return getDetector().then(function (d) {
      if (!d) { return null; }
      return d.detect(text).then(function (results) {
        if (!results || !results.length) { return null; }
        var top = results[0];
        if (top.confidence < 0.4 || top.detectedLanguage === 'und') { return null; }
        return String(top.detectedLanguage).split('-')[0];
      });
    }).then(null, function () { return null; });
  }

  /* =========================================================
   * 7. Audio capture, devices & playback
   * ========================================================= */
  var capCtx = null;       // 16 kHz capture context
  var localCtx = null;     // plays to my speakers/headset
  var radioCtx = null;     // plays to the radio's USB audio input
  var micInput = null;
  var rxInput = null;
  var activeSources = [];

  function ensureContexts() {
    if (!capCtx) { capCtx = new AudioContext({ sampleRate: SAMPLE_RATE }); }
    if (!localCtx) { localCtx = new AudioContext(); }
    if (!radioCtx) { radioCtx = new AudioContext(); }
    capCtx.resume();
    localCtx.resume();
    radioCtx.resume();
    return applySinks();
  }

  function applySinks() {
    if (!caps.sink || !localCtx) { return Promise.resolve(); }
    var p1 = localCtx.setSinkId(settings.devLocalOut || '').then(null, function (e) {
      errLog('Could not route to your speakers: ' + e.message);
    });
    var p2 = settings.devRadioOut ? radioCtx.setSinkId(settings.devRadioOut).then(null, function (e) {
      errLog('Could not route to the radio output: ' + e.message);
    }) : Promise.resolve();
    return Promise.all([p1, p2]);
  }

  function openInput(deviceId, echoCancel, onFrame) {
    var constraints = {
      audio: {
        echoCancellation: echoCancel,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1
      }
    };
    if (deviceId) { constraints.audio.deviceId = { exact: deviceId }; }
    return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
      var src = capCtx.createMediaStreamSource(stream);
      var proc = capCtx.createScriptProcessor(FRAME, 1, 1);
      var mute = capCtx.createGain();
      mute.gain.value = 0;
      proc.onaudioprocess = function (ev) {
        onFrame(new Float32Array(ev.inputBuffer.getChannelData(0)));
      };
      src.connect(proc);
      proc.connect(mute);
      mute.connect(capCtx.destination);
      return {
        close: function () {
          proc.onaudioprocess = null;
          try { src.disconnect(); proc.disconnect(); mute.disconnect(); } catch (e) { /* ignore */ }
          stream.getTracks().forEach(function (t) { t.stop(); });
        }
      };
    });
  }

  function rms(f) {
    var s = 0;
    for (var i = 0; i < f.length; i++) { s += f[i] * f[i]; }
    return Math.sqrt(s / f.length);
  }

  function concatFloat(chunks) {
    var len = 0, i;
    for (i = 0; i < chunks.length; i++) { len += chunks[i].length; }
    var out = new Float32Array(len);
    var off = 0;
    for (i = 0; i < chunks.length; i++) { out.set(chunks[i], off); off += chunks[i].length; }
    return out;
  }

  function normalize(f, peakTarget) {
    var peak = 0, i;
    for (i = 0; i < f.length; i++) { var a = Math.abs(f[i]); if (a > peak) { peak = a; } }
    if (peak < 1e-4) { return f; }
    var g = peakTarget / peak;
    for (i = 0; i < f.length; i++) { f[i] = f[i] * g; }
    return f;
  }

  function fillSelect(sel, devices, firstLabel, chosen) {
    sel.innerHTML = '';
    var o = el('option', null, firstLabel);
    o.value = '';
    sel.appendChild(o);
    for (var i = 0; i < devices.length; i++) {
      var d = devices[i];
      if (d.deviceId === 'default' || d.deviceId === 'communications') { continue; }
      var opt = el('option', null, d.label || ('Device ' + (i + 1)));
      opt.value = d.deviceId;
      sel.appendChild(opt);
    }
    sel.value = chosen || '';
    if (sel.value !== (chosen || '')) { sel.value = ''; }
  }

  function findCodec(devices) {
    for (var i = 0; i < devices.length; i++) {
      if (/usb audio codec/i.test(devices[i].label) && devices[i].deviceId !== 'default' && devices[i].deviceId !== 'communications') {
        return devices[i].deviceId;
      }
    }
    return '';
  }

  function listDevices() {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      var ins = [], outs = [];
      for (var i = 0; i < devs.length; i++) {
        if (devs[i].kind === 'audioinput') { ins.push(devs[i]); }
        if (devs[i].kind === 'audiooutput') { outs.push(devs[i]); }
      }
      if (!settings.devRadioIn) { settings.devRadioIn = findCodec(ins); }
      if (!settings.devRadioOut) { settings.devRadioOut = findCodec(outs); }
      fillSelect($('devRadioIn'), ins, '— choose radio input —', settings.devRadioIn);
      fillSelect($('devRadioOut'), outs, '— choose radio output —', settings.devRadioOut);
      fillSelect($('devMicIn'), ins, 'Default microphone', settings.devMicIn);
      fillSelect($('devLocalOut'), outs, 'Default speakers', settings.devLocalOut);
      settings.devRadioIn = $('devRadioIn').value;
      settings.devRadioOut = $('devRadioOut').value;
      saveSettings();
    });
  }

  function allowAudio() {
    if (!caps.media) { errLog('This browser cannot capture audio.'); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (s) {
      s.getTracks().forEach(function (t) { t.stop(); });
      return ensureContexts();
    }).then(listDevices).then(applySinks).then(openMic).then(function () {
      $('btnAllowAudio').textContent = 'Refresh device list';
      if (!settings.devRadioIn || !settings.devRadioOut) {
        banner('Pick the radio’s USB Audio CODEC for radio in and out. Is the USB cable connected and the radio on?', 'info', 9000);
      }
    }, function (e) {
      errLog('Audio permission was not granted: ' + e.message);
    });
  }

  function openMic() {
    if (micInput) { micInput.close(); micInput = null; }
    return openInput(settings.devMicIn, true, onMicFrame).then(function (h) {
      micInput = h;
      $('btnTalk').disabled = false;
    }, function (e) {
      errLog('Could not open your microphone: ' + e.message);
    });
  }

  function playOn(ctx, f32, sr, gain) {
    return new Promise(function (resolve) {
      if (!f32 || !f32.length) { resolve(); return; }
      var buf = ctx.createBuffer(1, f32.length, sr);
      buf.copyToChannel(f32, 0);
      var src = ctx.createBufferSource();
      src.buffer = buf;
      var g = ctx.createGain();
      g.gain.value = gain;
      src.connect(g);
      g.connect(ctx.destination);
      activeSources.push(src);
      src.onended = function () {
        var i = activeSources.indexOf(src);
        if (i >= 0) { activeSources.splice(i, 1); }
        resolve();
      };
      src.start();
    });
  }

  function stopAllPlayback() {
    for (var i = 0; i < activeSources.length; i++) {
      try { activeSources[i].stop(); } catch (e) { /* ignore */ }
    }
    activeSources = [];
    if (window.speechSynthesis) { window.speechSynthesis.cancel(); }
  }

  /* =========================================================
   * 8. Voices (neural MMS or system voice)
   * ========================================================= */
  var ttsFailed = {};      // model id -> true when it could not load

  function hasNeural(code) {
    var l = langByCode(code);
    return !!(l && l.mms && !ttsFailed[l.mms]);
  }

  // Say numbers digit by digit, ham style ("5 9" -> "five nine")
  function speakableText(text, code) {
    var words = DIGITS[code];
    var t = text;
    if (words) {
      t = t.replace(/(\d)[.,](?=\d)/g, '$1 ');
      t = t.replace(/\d/g, function (d) { return ' ' + words[+d] + ' '; });
    }
    return t.replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '').toLowerCase();
  }

  function splitSentences(text) {
    var parts = text.match(/[^.!?。！？]+[.!?。！？]*/g) || [text];
    var out = [], buf = '';
    for (var i = 0; i < parts.length; i++) {
      buf += parts[i];
      if (buf.length > 40 || i === parts.length - 1) {
        if (buf.replace(/\s/g, '')) { out.push(buf.replace(/^\s+|\s+$/g, '')); }
        buf = '';
      }
    }
    return out.length ? out : [text];
  }

  // Resolves {audio: Float32Array, sr} or rejects
  function synthNeural(text, code) {
    var l = langByCode(code);
    if (!l || !l.mms || ttsFailed[l.mms]) { return Promise.reject(new Error('No neural voice')); }
    var chunks = [];
    var sentences = splitSentences(text);
    var gap = new Float32Array(Math.round(SAMPLE_RATE * 0.12));
    var sr = SAMPLE_RATE;
    var p = Promise.resolve();
    sentences.forEach(function (s) {
      p = p.then(function () {
        var spoken = speakableText(s, code);
        if (!spoken) { return; }
        return rpc({ type: 'tts', model: l.mms, text: spoken }).then(function (m) {
          sr = m.sampling_rate || SAMPLE_RATE;
          chunks.push(m.audio);
          chunks.push(gap);
        });
      });
    });
    return p.then(function () {
      if (!chunks.length) { throw new Error('Nothing to say'); }
      return { audio: normalize(concatFloat(chunks), 0.9), sr: sr };
    }, function (err) {
      if (err && err.message !== 'Nothing to say' && !ttsFailed[l.mms]) {
        ttsFailed[l.mms] = true;
        sysLog('Neural ' + l.name + ' voice unavailable (' + err.message + '). Using the system voice instead.');
      }
      throw err;
    });
  }

  function pickSystemVoice(code) {
    if (!window.speechSynthesis) { return null; }
    var voices = window.speechSynthesis.getVoices();
    var best = null;
    for (var i = 0; i < voices.length; i++) {
      if (voices[i].lang && voices[i].lang.toLowerCase().indexOf(code) === 0) {
        if (!best || /natural|neural|online/i.test(voices[i].name)) { best = voices[i]; }
      }
    }
    return best;
  }

  function systemSpeak(text, code) {
    return new Promise(function (resolve) {
      if (!window.speechSynthesis) { resolve(); return; }
      var u = new SpeechSynthesisUtterance(text);
      var l = langByCode(code);
      u.lang = l ? l.bcp : code;
      var v = pickSystemVoice(code);
      if (v) { u.voice = v; }
      var done = false;
      function finish() { if (!done) { done = true; resolve(); } }
      u.onend = finish;
      u.onerror = finish;
      setTimeout(finish, 4000 + text.length * 110);   // Chrome sometimes never fires onend
      window.speechSynthesis.speak(u);
    });
  }

  // Speak to my speakers/headset. With default speakers, a good system
  // voice sounds better; with a chosen output, use the routable neural voice.
  function speakLocal(text, code) {
    var preferSystem = !settings.devLocalOut && pickSystemVoice(code);
    if (hasNeural(code) && !preferSystem) {
      return synthNeural(text, code).then(function (r) {
        return playOn(localCtx, r.audio, r.sr, 1);
      }, function () { return systemSpeak(text, code); });
    }
    return systemSpeak(text, code);
  }

  /* =========================================================
   * 9. Radio connection (Web Serial)
   * ========================================================= */
  var rig = {
    port: null, writer: null, reader: null, connected: false,
    keyed: false, buf: '', pollTimer: null, freqText: ''
  };
  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function rigConnect() {
    if (settings.pttMethod === 'vox') {
      sysLog('VOX mode: no serial connection needed. Turn VOX on at the radio.');
      return;
    }
    if (!caps.serial) { errLog('Web Serial is not available in this browser. Use Chrome or Edge on a desktop, or choose VOX.'); return; }
    var filters = settings.onlyYaesu ? [{ usbVendorId: 0x10C4 }] : [];
    navigator.serial.requestPort({ filters: filters }).then(function (port) {
      rig.port = port;
      return port.open({
        baudRate: parseInt(settings.baud, 10),
        dataBits: 8,
        stopBits: parseInt(settings.stopBits, 10),
        parity: 'none',
        flowControl: settings.flow
      });
    }).then(function () {
      // Opening a port can raise RTS/DTR. For line keying, drop them at once.
      if (settings.pttMethod === 'rts' || settings.pttMethod === 'dtr') {
        return rig.port.setSignals({ requestToSend: false, dataTerminalReady: false });
      }
    }).then(function () {
      rig.connected = true;
      rig.keyed = false;
      rig.writer = rig.port.writable.getWriter();
      startReader();
      if (settings.pttMethod === 'cat') { startPolling(); }
      setLamp('lampRig', 'on');
      $('btnConnect').disabled = true;
      $('btnDisconnect').disabled = false;
      $('rigStatus').textContent = 'Connected (' + settings.pttMethod.toUpperCase() + ' keying, ' + settings.baud + ' baud).';
      sysLog('Radio connected. PTT by ' + settings.pttMethod.toUpperCase() + '.');
    }).then(null, function (e) {
      if (e && e.name === 'NotFoundError') { return; }  // user closed the picker
      setLamp('lampRig', 'err');
      var hint = /already open|failed to open/i.test(e.message) ? ' Another program (WSJT-X, logging software) may be using that port.' : '';
      errLog('Could not open the radio port: ' + e.message + hint);
      rigCleanup();
    });
  }

  function startReader() {
    if (!rig.port || !rig.port.readable) { return; }
    rig.reader = rig.port.readable.getReader();
    function pump() {
      return rig.reader.read().then(function (r) {
        if (r.done) { return; }
        rig.buf += decoder.decode(r.value, { stream: true });
        parseCat();
        return pump();
      });
    }
    pump().then(null, function () { /* port closed */ }).then(function () {
      try { rig.reader.releaseLock(); } catch (e) { /* ignore */ }
    });
  }

  function parseCat() {
    var idx = rig.buf.indexOf(';');
    while (idx >= 0) {
      var msg = rig.buf.substring(0, idx);
      rig.buf = rig.buf.substring(idx + 1);
      var m = /^FA(\d{9})$/.exec(msg);
      if (m) { showFreq(parseInt(m[1], 10)); }
      m = /^MD0([0-9A-E])$/.exec(msg);
      if (m) { $('vfoMode').textContent = MODES[m[1]] || m[1]; }
      idx = rig.buf.indexOf(';');
    }
    if (rig.buf.length > 200) { rig.buf = ''; }
  }

  function showFreq(hz) {
    var mhz = Math.floor(hz / 1000000);
    var khz = Math.floor((hz % 1000000) / 1000);
    var h = hz % 1000;
    function pad(n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; }
    rig.freqText = mhz + '.' + pad(khz) + '.' + pad(h);
    $('vfoFreq').textContent = rig.freqText;
    $('vfo').className = 'vfo';
  }

  function startPolling() {
    stopPolling();
    rig.pollTimer = setInterval(function () {
      if (rig.connected && !rig.keyed && settings.pttMethod === 'cat') {
        rigWrite('FA;MD0;').then(null, function () { /* ignore poll errors */ });
      }
    }, 2000);
  }
  function stopPolling() {
    if (rig.pollTimer) { clearInterval(rig.pollTimer); rig.pollTimer = null; }
  }

  function rigWrite(text) {
    if (!rig.writer) { return Promise.reject(new Error('Radio not connected')); }
    return rig.writer.write(encoder.encode(text));
  }

  function setPTT(on) {
    var method = settings.pttMethod;
    var p;
    if (method === 'vox') {
      p = Promise.resolve();
    } else if (!rig.connected) {
      p = on ? Promise.reject(new Error('Radio not connected. Click "Connect radio" or choose VOX.')) : Promise.resolve();
    } else if (method === 'cat') {
      p = rigWrite(on ? 'TX1;' : 'TX0;');
    } else if (method === 'rts') {
      p = rig.port.setSignals({ requestToSend: on });
    } else {
      p = rig.port.setSignals({ dataTerminalReady: on });
    }
    return p.then(function () {
      rig.keyed = on;
      setLamp('lampTX', on ? 'on' : '');
    });
  }

  function rigCleanup() {
    stopPolling();
    rig.connected = false;
    rig.keyed = false;
    setLamp('lampTX', '');
    $('btnConnect').disabled = false;
    $('btnDisconnect').disabled = true;
    $('rigStatus').textContent = 'Not connected.';
  }

  function rigDisconnect() {
    var port = rig.port;
    setPTT(false).then(null, function () {}).then(function () {
      stopPolling();
      var p = Promise.resolve();
      if (rig.reader) { p = rig.reader.cancel().then(null, function () {}); }
      return p;
    }).then(function () {
      if (rig.writer) { try { rig.writer.releaseLock(); } catch (e) { /* ignore */ } }
      rig.writer = null;
      rig.reader = null;
      return port ? port.close().then(null, function () {}) : null;
    }).then(function () {
      rig.port = null;
      rigCleanup();
      setLamp('lampRig', '');
      sysLog('Radio disconnected.');
    });
  }

  function testKey() {
    var ok = window.confirm('This keys your transmitter for 1.5 seconds. Make sure an antenna or dummy load is connected and the frequency is clear.');
    if (!ok) { return; }
    setPTT(true).then(function () {
      return wait(1500);
    }).then(function () {
      return setPTT(false);
    }).then(function () {
      sysLog('Test key complete. Did the radio show TX?');
    }, function (e) {
      setPTT(false).then(null, function () {});
      errLog('Keying failed: ' + e.message);
    });
  }

  /* =========================================================
   * 10. Receive pipeline
   * ========================================================= */
  var rx = {
    on: false, noise: 0, inSeg: false, seg: [], silence: 0, preroll: [],
    queue: [], busy: false, ignoreUntil: 0, lastLang: null
  };

  function toggleListen() {
    if (rx.on) { stopListening(); return; }
    if (!settings.devRadioIn) {
      banner('Choose the radio receive input first (step 2).', null, 6000);
      return;
    }
    ensureContexts().then(function () {
      return openInput(settings.devRadioIn, false, onRxFrame);
    }).then(function (h) {
      rxInput = h;
      rx.on = true;
      rx.noise = 0;
      $('btnListen').textContent = 'Stop listening';
      $('btnListen').className = 'btn active';
      setLamp('lampRX', 'on');
      ensureASR().then(null, function (e) { errLog('Speech model failed to load: ' + e.message); });
    }, function (e) {
      errLog('Could not open the radio input: ' + e.message);
    });
  }

  function stopListening() {
    if (rxInput) { rxInput.close(); rxInput = null; }
    rx.on = false;
    rx.inSeg = false;
    rx.seg = [];
    $('btnListen').textContent = 'Start listening';
    $('btnListen').className = 'btn primary';
    setLamp('lampRX', '');
    $('rxMeter').style.width = '0';
  }

  function onRxFrame(f) {
    var level = rms(f);
    // Noise floor: drops fast, rises slowly
    if (!rx.noise) { rx.noise = level || 1e-5; }
    else if (level < rx.noise) { rx.noise = rx.noise * 0.8 + level * 0.2; }
    else { rx.noise = rx.noise * 0.997 + level * 0.003; }
    if (rx.noise < 1e-5) { rx.noise = 1e-5; }

    var dbfs = 20 * Math.log(level + 1e-9) / Math.LN10;
    var noiseDb = 20 * Math.log(rx.noise) / Math.LN10;
    var above = dbfs - noiseDb;
    var active = above >= settings.sens;
    updateMeter(dbfs, noiseDb + settings.sens, active);

    var ignoring = txBusy || Date.now() < rx.ignoreUntil;
    if (ignoring) {
      rx.inSeg = false;
      rx.seg = [];
      rx.preroll = [];
      return;
    }

    if (!rx.inSeg) {
      rx.preroll.push(f);
      if (rx.preroll.length > PREROLL_FRAMES) { rx.preroll.shift(); }
      if (active) {
        rx.inSeg = true;
        rx.seg = rx.preroll.slice();
        rx.preroll = [];
        rx.silence = 0;
        setLamp('lampRX', 'busy');
      }
      return;
    }

    rx.seg.push(f);
    rx.silence = active ? 0 : rx.silence + FRAME_SEC;
    var segSec = rx.seg.length * FRAME_SEC;
    if (rx.silence >= settings.hang || segSec >= MAX_SEG_SEC) {
      var voiced = segSec - rx.silence;
      var audio = concatFloat(rx.seg);
      rx.inSeg = segSec >= MAX_SEG_SEC && rx.silence < settings.hang;  // keep going if cut by length
      rx.seg = [];
      rx.silence = 0;
      if (!rx.inSeg) { setLamp('lampRX', rx.on ? 'on' : ''); }
      if (voiced >= MIN_SEG_SEC) {
        rx.queue.push(audio);
        processRxQueue();
      }
    }
  }

  var meterTick = 0;
  function updateMeter(dbfs, triggerDb, active) {
    meterTick++;
    if (meterTick % 2) { return; }
    var pct = Math.max(0, Math.min(100, (dbfs + 80) / 80 * 100));
    var mark = Math.max(0, Math.min(100, (triggerDb + 80) / 80 * 100));
    var fill = $('rxMeter');
    fill.style.width = pct + '%';
    fill.className = 'meterfill' + (active ? ' hot' : '');
    $('rxMark').style.left = mark + '%';
    $('rxDb').textContent = Math.round(dbfs) + ' dBFS';
  }

  function processRxQueue() {
    if (rx.busy || !rx.queue.length) { return; }
    rx.busy = true;
    var audio = rx.queue.shift();
    handleRx(audio).then(null, function (e) {
      errLog('Receive error: ' + e.message);
    }).then(function () {
      rx.busy = false;
      processRxQueue();
    });
  }

  function handleRx(audio) {
    var their = settings.theirLang;
    var mine = settings.myLang;
    var entry = addEntry('rx', 'Transcribing…', { working: true });
    var useWhisperTranslate = !caps.translator && mine === 'en';
    var whisperLang = their === 'auto' ? null : langByCode(their).whisper;
    var task = useWhisperTranslate ? 'translate' : 'transcribe';
    var heard = '';

    return transcribe(audio, whisperLang, task).then(function (text) {
      heard = cleanTranscript(text);
      if (!heard) { entry.remove(); return null; }
      if (useWhisperTranslate) {
        entry.set(heard);
        entry.badge('Whisper → EN');
        return null;
      }
      entry.set(heard + '  …translating', true);
      return their === 'auto' ? detectLang(heard) : their;
    }).then(function (src) {
      if (!heard) { return null; }
      if (useWhisperTranslate) { return heard; }
      if (src) { rx.lastLang = src; }
      if (!src) {
        entry.set(heard);
        entry.badge('language ?');
        return null;
      }
      entry.badge(langName(src) + ' → ' + langName(mine));
      if (src === mine) { entry.set(heard); return heard; }
      return translate(src, mine, heard).then(function (out) {
        entry.orig(heard);
        entry.set(out);
        return out;
      }, function (e) {
        entry.set(heard);
        errLog(e.message);
        return null;
      });
    }).then(function (spoken) {
      if (!spoken) { return; }
      entry.action('▶ Replay', function () { speakLocal(spoken, mine); });
      if (settings.speakRx && !txBusy) { return speakLocal(spoken, mine); }
    }, function (e) {
      entry.set('Could not transcribe: ' + e.message);
    });
  }

  /* =========================================================
   * 11. Transmit pipeline
   * ========================================================= */
  var talk = { recording: false, frames: [], started: 0, timer: null };
  var txBusy = false;
  var txAbort = false;
  var pending = null;     // awaiting review

  function onMicFrame(f) {
    if (talk.recording) { talk.frames.push(f); }
  }

  function talkStart() {
    if (talk.recording || txBusy) { return; }
    if (!micInput) { banner('Click "Allow audio" first (step 2).', null, 5000); return; }
    ensureContexts();
    talk.recording = true;
    talk.frames = [];
    talk.started = Date.now();
    $('btnTalk').className = 'talk recording';
    talk.timer = setInterval(function () {
      $('talkSub').textContent = 'listening… ' + ((Date.now() - talk.started) / 1000).toFixed(1) + ' s';
      if (Date.now() - talk.started > MAX_SEG_SEC * 1000) { talkStop(); }
    }, 100);
    ensureASR().then(null, function () {});
  }

  function talkStop(cancel) {
    if (!talk.recording) { return; }
    talk.recording = false;
    clearInterval(talk.timer);
    $('btnTalk').className = 'talk';
    $('talkSub').textContent = 'space bar works too';
    var frames = talk.frames;
    talk.frames = [];
    if (cancel) { return; }
    var secs = frames.length * FRAME_SEC;
    if (secs < 0.5) { banner('Hold the button while you speak.', 'info', 3000); return; }
    handleMyAudio(concatFloat(frames));
  }

  function handleMyAudio(audio) {
    var mine = settings.myLang;
    var entry = addEntry('tx', 'Transcribing what you said…', { working: true });
    transcribe(audio, langByCode(mine).whisper, 'transcribe').then(function (text) {
      var said = cleanTranscript(text);
      if (!said) { entry.set('Didn’t catch that – try again.'); return; }
      prepareOutgoing(said, entry);
    }, function (e) {
      entry.set('Could not transcribe: ' + e.message);
    });
  }

  function targetLang() {
    return settings.theirLang === 'auto' ? rx.lastLang : settings.theirLang;
  }

  function prepareOutgoing(text, entry) {
    var mine = settings.myLang;
    var target = targetLang();
    if (!entry) { entry = addEntry('tx', text, { working: true }); }
    if (!target) {
      entry.set(text);
      errLog('No target language yet. Pick the other station’s language, or wait until you have heard them in auto-detect mode.');
      return;
    }
    entry.set(text + '  …translating', true);
    translate(mine, target, text).then(function (out) {
      entry.badge(langName(mine) + ' → ' + langName(target));
      entry.orig(text);
      if (settings.reviewTx) {
        entry.set(out + '  (waiting for review)', true);
        showReview({ orig: text, text: out, target: target, entry: entry });
      } else {
        entry.set(out, true);
        sendTranslated(text, out, target, entry);
      }
    }, function (e) {
      entry.set(text);
      errLog(e.message);
    });
  }

  function showReview(p) {
    pending = p;
    $('reviewLang').textContent = langName(p.target);
    $('reviewSrc').textContent = p.orig;
    $('reviewText').value = p.text;
    $('review').hidden = false;
    $('btnTransmit').focus();
  }

  function hideReview() {
    pending = null;
    $('review').hidden = true;
  }

  function retranslatePending() {
    if (!pending) { return; }
    var orig = $('reviewSrc').textContent.replace(/^\s+|\s+$/g, '');
    if (!orig) { return; }
    pending.orig = orig;
    translate(settings.myLang, pending.target, orig).then(function (out) {
      pending.text = out;
      $('reviewText').value = out;
      pending.entry.orig(orig);
    }, function (e) { errLog(e.message); });
  }

  function transmitPending() {
    if (!pending) { return; }
    var p = pending;
    var text = $('reviewText').value.replace(/^\s+|\s+$/g, '');
    hideReview();
    if (!text) { p.entry.set('(discarded)'); return; }
    p.entry.set(text, true);
    sendTranslated(p.orig, text, p.target, p.entry);
  }

  function discardPending() {
    if (pending) { pending.entry.set('(discarded)'); }
    hideReview();
  }

  function sendTranslated(orig, text, target, entry) {
    var parts = [{ text: text, lang: target }];
    if (idDue()) {
      if (settings.callsign) { parts.push({ text: idText(), lang: 'en', isId: true }); }
      else { banner('Add your callsign in step 4 so RigLingo can give your English station ID.', null, 8000); }
    }
    transmit(parts).then(function () {
      entry.set(text);
      entry.action('▶ Hear it', function () { speakLocal(text, target); });
      entry.action('↻ Resend', function () { sendTranslated(orig, text, target, entry); });
    }, function (e) {
      entry.set(text + '  (not sent)');
      errLog('Transmit failed: ' + e.message);
    });
  }

  // parts: [{text, lang, isId}]
  function transmit(parts) {
    if (txBusy) { return Promise.reject(new Error('Already transmitting')); }
    if (!settings.devRadioOut) { return Promise.reject(new Error('Choose the radio transmit output in step 2.')); }
    if (settings.pttMethod !== 'vox' && !rig.connected) {
      return Promise.reject(new Error('Radio not connected. Click "Connect radio" or choose VOX.'));
    }
    txBusy = true;
    txAbort = false;
    $('btnTalk').disabled = true;
    $('talkSub').textContent = 'preparing audio…';

    var clips = [];
    var sentId = false;
    var timeout = null;

    // 1) Render all audio before keying so the carrier is up as briefly as possible
    var render = Promise.resolve();
    parts.forEach(function (part) {
      render = render.then(function () {
        return synthNeural(part.text, part.lang).then(function (r) {
          clips.push({ audio: r.audio, sr: r.sr, isId: part.isId });
        }, function () {
          clips.push({ system: true, text: part.text, lang: part.lang, isId: part.isId });
          sysLog('Using the system voice for ' + langName(part.lang) + '. It plays on the Windows default output, not the radio output you picked.');
        });
      });
    });

    return ensureContexts().then(function () {
      return render;
    }).then(function () {
      if (txAbort) { throw new Error('Cancelled'); }
      $('talkSub').textContent = 'On air. Press Esc to stop.';
      return setPTT(true);
    }).then(function () {
      timeout = setTimeout(function () {
        errLog('TX timeout reached (' + settings.txTimeout + ' s). Unkeyed.');
        abortTx();
      }, settings.txTimeout * 1000);
      return wait(settings.leadIn);
    }).then(function () {
      var play = Promise.resolve();
      clips.forEach(function (c) {
        play = play.then(function () {
          if (txAbort) { return; }
          if (c.isId) { sentId = true; }
          if (c.system) { return systemSpeak(c.text, c.lang); }
          return playOn(radioCtx, c.audio, c.sr, settings.txGain / 100);
        });
      });
      return play;
    }).then(function () {
      return wait(250);
    }).then(function () {
      return finishTx(timeout, sentId);
    }, function (err) {
      return finishTx(timeout, false).then(function () { throw err; });
    });
  }

  function finishTx(timeout, sentId) {
    if (timeout) { clearTimeout(timeout); }
    return setPTT(false).then(null, function (e) {
      errLog('UNKEY FAILED: ' + e.message + ' – unkey the radio by hand!');
    }).then(function () {
      txBusy = false;
      rx.ignoreUntil = Date.now() + 800;
      $('btnTalk').disabled = !micInput;
      $('talkSub').textContent = 'space bar works too';
      if (sentId) { markIdSent(); }
    });
  }

  function abortTx() {
    txAbort = true;
    stopAllPlayback();
    setPTT(false).then(null, function (e) {
      errLog('UNKEY FAILED: ' + e.message + ' – unkey the radio by hand!');
    });
  }

  /* =========================================================
   * 12. Station ID
   * ========================================================= */
  var lastIdAt = 0;

  function idText() {
    var cs = (settings.callsign || '').toUpperCase().replace(/[^A-Z0-9\/]/g, '');
    var words = [];
    for (var i = 0; i < cs.length; i++) { words.push(PHONETIC[cs.charAt(i)] || cs.charAt(i)); }
    return 'This is ' + words.join(' ') + '.';
  }

  function idDue() {
    if (settings.idMode === 'every') { return true; }
    if (settings.idMode === 'manual') { return false; }
    return !lastIdAt || (Date.now() - lastIdAt) >= 9.5 * 60000;
  }

  function markIdSent() {
    lastIdAt = Date.now();
    updateIdTimer();
  }

  function sendIdNow() {
    if (!settings.callsign) {
      banner('Add your callsign in step 4 first.', null, 5000);
      $('cardStation').open = true;
      $('callsign').focus();
      return;
    }
    var entry = addEntry('tx', idText(), { badge: 'English ID' });
    transmit([{ text: idText(), lang: 'en', isId: true }]).then(null, function (e) {
      entry.set(idText() + '  (not sent)');
      errLog('ID failed: ' + e.message);
    });
  }

  function updateIdTimer() {
    var n = $('idTimer');
    if (!lastIdAt) { n.textContent = 'ID: not yet sent'; n.className = 'idtimer'; return; }
    var s = Math.floor((Date.now() - lastIdAt) / 1000);
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    n.textContent = 'Last ID ' + mm + ':' + (ss < 10 ? '0' : '') + ss + ' ago';
    n.className = 'idtimer' + (s >= 570 ? ' due' : '');
  }

  /* =========================================================
   * 13. UI wiring & start-up
   * ========================================================= */
  function fillLangSelects() {
    var their = $('theirLang');
    var mine = $('myLang');
    their.innerHTML = '';
    mine.innerHTML = '';
    var auto = el('option', null, 'Auto-detect');
    auto.value = 'auto';
    their.appendChild(auto);
    for (var i = 0; i < LANGS.length; i++) {
      var label = LANGS[i].name + (LANGS[i].mms ? '' : ' (system voice)');
      var o1 = el('option', null, label);
      o1.value = LANGS[i].code;
      their.appendChild(o1);
      var o2 = el('option', null, label);
      o2.value = LANGS[i].code;
      mine.appendChild(o2);
    }
    their.value = settings.theirLang;
    mine.value = settings.myLang;
  }

  function bindSetting(id, key, kind, after) {
    var n = $(id);
    if (kind === 'check') { n.checked = !!settings[key]; }
    else { n.value = settings[key]; }
    n.addEventListener('change', function () {
      if (kind === 'check') { settings[key] = n.checked; }
      else if (kind === 'num') { settings[key] = parseFloat(n.value); }
      else { settings[key] = n.value; }
      saveSettings();
      if (after) { after(); }
    });
  }

  function bindRange(id, key, labelId, fmt) {
    var n = $(id);
    n.value = settings[key];
    $(labelId).textContent = fmt(settings[key]);
    n.addEventListener('input', function () {
      settings[key] = parseFloat(n.value);
      $(labelId).textContent = fmt(settings[key]);
      saveSettings();
    });
  }

  function prepare() {
    var list = $('prepStatus');
    list.innerHTML = '';
    function row(text) {
      var li = el('li', 'wait', text);
      list.appendChild(li);
      return {
        ok: function (t) { li.className = 'ok'; if (t) { li.textContent = t; } },
        bad: function (t) { li.className = 'bad'; if (t) { li.textContent = t; } },
        warn: function (t) { li.className = 'warn'; if (t) { li.textContent = t; } }
      };
    }
    var mine = settings.myLang;
    var their = settings.theirLang;
    $('btnPrepare').disabled = true;

    // Translator downloads need this click (user activation), so start them first
    var tasks = [];
    if (their !== 'auto' && their !== mine) {
      [[their, mine], [mine, their]].forEach(function (pair) {
        var r = row('Translator ' + langName(pair[0]) + ' → ' + langName(pair[1]));
        tasks.push(getTranslator(pair[0], pair[1]).then(function () { r.ok(); }, function (e) { r.bad(e.message); }));
      });
    }
    if (their === 'auto') {
      var rd = row('Language auto-detect');
      tasks.push(getDetector().then(function (d) {
        if (d) { rd.ok(); } else { rd.warn('Auto-detect unavailable – pick a language instead'); }
      }));
      sysLog('Auto-detect mode: translation packs download the first time each new language is heard. If one is blocked, pick that language and click "Download & prepare".');
    }

    var ra = row('Speech recognition (' + $('asrModel').options[$('asrModel').selectedIndex].text.split(' –')[0] + ')');
    tasks.push(ensureASR().then(function () {
      ra.ok('Speech recognition ready (' + (ai.device === 'webgpu' ? 'WebGPU' : 'CPU') + ')');
    }, function (e) { ra.bad('Speech recognition failed: ' + e.message); }));

    var voiceLangs = [mine];
    if (their !== 'auto' && their !== mine) { voiceLangs.push(their); }
    voiceLangs.forEach(function (code) {
      var l = langByCode(code);
      if (!l.mms) {
        row(l.name + ' voice: system voice (plays on Windows default output)').warn();
        return;
      }
      var r = row(l.name + ' neural voice');
      tasks.push(rpc({ type: 'load-tts', model: l.mms }, showProgress).then(function () {
        r.ok(l.name + ' neural voice ready');
      }, function (e) {
        ttsFailed[l.mms] = true;
        r.warn(l.name + ' neural voice unavailable – using system voice');
      }));
    });

    Promise.all(tasks).then(function () {
      $('btnPrepare').disabled = false;
      $('prepProgress').hidden = true;
    });
  }

  function testVoice(which) {
    var code = which === 'mine' ? settings.myLang : targetLang();
    if (!code) { banner('Pick the other station’s language first.', 'info', 4000); return; }
    var samples = {
      en: 'Thanks for the call. Your signal is five nine here.',
      fr: 'Merci pour l’appel. Votre signal est cinq neuf ici.',
      es: 'Gracias por la llamada. Su señal es cinco nueve aquí.',
      de: 'Danke für den Anruf. Ihr Signal ist fünf neun hier.',
      it: 'Grazie per la chiamata. Il tuo segnale è cinque nove qui.',
      pt: 'Obrigado pela chamada. Seu sinal está cinco nove aqui.'
    };
    ensureContexts().then(function () {
      var text = samples[code];
      if (text) { return speakLocal(text, code); }
      return translate('en', code, samples.en).then(function (t) { return speakLocal(t, code); });
    }).then(null, function (e) { errLog('Voice test failed: ' + e.message); });
  }

  function isTyping(t) {
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
  }

  function wire() {
    $('appVersion').textContent = VERSION;
    fillLangSelects();

    bindSetting('pttMethod', 'pttMethod', 'text', function () {
      if (rig.connected) { banner('PTT method changed – disconnect and reconnect the radio.', 'info', 6000); }
    });
    bindSetting('baud', 'baud', 'text');
    bindSetting('stopBits', 'stopBits', 'text');
    bindSetting('flow', 'flow', 'text');
    bindSetting('onlyYaesu', 'onlyYaesu', 'check');
    bindSetting('devRadioIn', 'devRadioIn', 'text', function () { if (rx.on) { stopListening(); toggleListen(); } });
    bindSetting('devRadioOut', 'devRadioOut', 'text', applySinks);
    bindSetting('devMicIn', 'devMicIn', 'text', openMic);
    bindSetting('devLocalOut', 'devLocalOut', 'text', applySinks);
    bindSetting('theirLang', 'theirLang', 'text');
    bindSetting('myLang', 'myLang', 'text');
    bindSetting('asrModel', 'asrModel', 'text', function () { ai.asrReady = false; });
    bindSetting('callsign', 'callsign', 'text');
    bindSetting('idMode', 'idMode', 'text');
    bindSetting('reviewTx', 'reviewTx', 'check');
    bindSetting('speakRx', 'speakRx', 'check');
    bindSetting('showOriginal', 'showOriginal', 'check');
    bindSetting('leadIn', 'leadIn', 'num');
    bindSetting('txTimeout', 'txTimeout', 'num');
    bindRange('sens', 'sens', 'sensVal', function (v) { return String(v); });
    bindRange('hang', 'hang', 'hangVal', function (v) { return v.toFixed(1); });
    bindRange('txGain', 'txGain', 'txGainVal', function (v) { return String(Math.round(v)); });

    $('btnConnect').addEventListener('click', rigConnect);
    $('btnDisconnect').addEventListener('click', rigDisconnect);
    $('btnTestPTT').addEventListener('click', testKey);
    $('btnUnkey').addEventListener('click', function () { abortTx(); sysLog('Unkey sent.'); });
    $('btnAllowAudio').addEventListener('click', allowAudio);
    $('btnPrepare').addEventListener('click', prepare);
    $('btnTestVoice').addEventListener('click', function () { testVoice('theirs'); });
    $('btnTestMyVoice').addEventListener('click', function () { testVoice('mine'); });
    $('btnListen').addEventListener('click', toggleListen);
    $('btnID').addEventListener('click', sendIdNow);
    $('btnClear').addEventListener('click', function () { $('log').innerHTML = ''; });
    $('btnTransmit').addEventListener('click', transmitPending);
    $('btnRetranslate').addEventListener('click', retranslatePending);
    $('btnDiscard').addEventListener('click', discardPending);
    $('reviewSrc').setAttribute('contenteditable', 'true');
    $('reviewSrc').title = 'You can fix the transcription here, then Re-translate';

    $('btnTypeSend').addEventListener('click', function () {
      var t = $('typeText').value.replace(/^\s+|\s+$/g, '');
      if (!t) { return; }
      $('typeText').value = '';
      ensureContexts();
      prepareOutgoing(t, null);
    });

    var talkBtn = $('btnTalk');
    talkBtn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { talkBtn.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
      talkStart();
    });
    talkBtn.addEventListener('pointerup', function () { talkStop(false); });
    talkBtn.addEventListener('pointercancel', function () { talkStop(true); });
    talkBtn.addEventListener('contextmenu', function (e) { e.preventDefault(); });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        if (txBusy) { abortTx(); sysLog('Transmission stopped.'); }
        talkStop(true);
        return;
      }
      if ((e.code === 'Space' || e.key === ' ') && !e.repeat && !isTyping(e.target) && !$('btnTalk').disabled) {
        e.preventDefault();
        talkStart();
      }
    });
    document.addEventListener('keyup', function (e) {
      if ((e.code === 'Space' || e.key === ' ') && !isTyping(e.target)) {
        e.preventDefault();
        talkStop(false);
      }
    });

    if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', function () {
        if (capCtx) { listDevices(); }
      });
    }
    if (caps.serial) {
      navigator.serial.addEventListener('disconnect', function (e) {
        if (rig.port && e.target === rig.port) {
          rig.port = null;
          rig.writer = null;
          rig.reader = null;
          rigCleanup();
          setLamp('lampRig', 'err');
          errLog('Radio USB connection lost. If it was transmitting, check the radio.');
        }
      });
    }
    window.addEventListener('beforeunload', function () {
      if (rig.keyed) { setPTT(false); }
    });
    if (window.speechSynthesis) { window.speechSynthesis.getVoices(); }

    setInterval(updateIdTimer, 1000);
  }

  function registerSW() {
    if ('serviceWorker' in navigator && window.isSecureContext) {
      navigator.serviceWorker.register('sw.js').then(null, function () { /* offline cache optional */ });
    }
  }

  loadSettings();
  $('vfo').className = 'vfo idle';
  runChecks();
  wire();
  startWorker();
  registerSW();
  if (!caps.translator) {
    banner('Translation and radio control need Chrome or Edge on a Windows, Mac or Linux computer. On this device you can look around, but RigLingo can’t operate the radio.', null);
  }
})();
