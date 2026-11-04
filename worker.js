/*
 * RigLingo speech worker (v1.0.0)
 * Runs Whisper speech recognition and MMS neural text-to-speech off the
 * main thread with Transformers.js.
 *
 * NOTE: the single `import` line below is the one non-ES5 statement in the
 * project. Transformers.js only ships as an ES module, so this file is
 * loaded as a module worker. Everything else is written in ES5.
 */
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3';

env.allowLocalModels = false;
env.useBrowserCache = true;

var asr = null;
var asrKey = '';
var asrLoading = null;
var ttsCache = {};
var ttsLoading = {};
var gpuChecked = false;
var gpuOK = false;

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function progressFn(id, what) {
  return function (p) {
    if (!p) { return; }
    post({
      id: id,
      type: 'progress',
      what: what,
      status: p.status || '',
      file: p.file || '',
      progress: typeof p.progress === 'number' ? p.progress : null
    });
  };
}

function checkGPU() {
  if (gpuChecked) { return Promise.resolve(gpuOK); }
  if (!self.navigator || !self.navigator.gpu) {
    gpuChecked = true;
    gpuOK = false;
    return Promise.resolve(false);
  }
  return self.navigator.gpu.requestAdapter().then(function (a) {
    gpuChecked = true;
    gpuOK = !!a;
    return gpuOK;
  }, function () {
    gpuChecked = true;
    gpuOK = false;
    return false;
  });
}

function loadASR(id, model) {
  if (asr && asrKey === model) {
    return Promise.resolve({ device: gpuOK ? 'webgpu' : 'wasm' });
  }
  if (asrLoading && asrKey === model) { return asrLoading; }
  asrKey = model;
  asr = null;
  asrLoading = checkGPU().then(function (useGPU) {
    var opts = { progress_callback: progressFn(id, 'asr') };
    if (useGPU) {
      opts.device = 'webgpu';
      opts.dtype = { encoder_model: 'fp32', decoder_model_merged: 'q4' };
    } else {
      opts.device = 'wasm';
      opts.dtype = 'q8';
    }
    return pipeline('automatic-speech-recognition', model, opts).then(function (p) {
      asr = p;
      asrLoading = null;
      return { device: opts.device };
    }, function (err) {
      if (!useGPU) { throw err; }
      // WebGPU failed: fall back to WASM once
      gpuOK = false;
      opts.device = 'wasm';
      opts.dtype = 'q8';
      return pipeline('automatic-speech-recognition', model, opts).then(function (p2) {
        asr = p2;
        asrLoading = null;
        return { device: 'wasm' };
      });
    });
  });
  asrLoading.then(null, function () { asrLoading = null; asrKey = ''; });
  return asrLoading;
}

function loadTTS(id, model) {
  if (ttsCache[model]) { return Promise.resolve(ttsCache[model]); }
  if (ttsLoading[model]) { return ttsLoading[model]; }
  ttsLoading[model] = pipeline('text-to-speech', model, {
    device: 'wasm',
    progress_callback: progressFn(id, 'tts')
  }).then(function (p) {
    ttsCache[model] = p;
    delete ttsLoading[model];
    return p;
  }, function (err) {
    delete ttsLoading[model];
    throw err;
  });
  return ttsLoading[model];
}

function errText(err) {
  if (!err) { return 'Unknown error'; }
  return err.message ? err.message : String(err);
}

self.onmessage = function (e) {
  var m = e.data || {};
  var id = m.id;

  if (m.type === 'load-asr') {
    loadASR(id, m.model).then(function (info) {
      post({ id: id, type: 'done', device: info.device });
    }, function (err) {
      post({ id: id, type: 'error', error: errText(err) });
    });
    return;
  }

  if (m.type === 'asr') {
    loadASR(id, m.model).then(function () {
      var opts = { task: m.task || 'transcribe', chunk_length_s: 30, stride_length_s: 5 };
      if (m.language) { opts.language = m.language; }
      return asr(m.audio, opts);
    }).then(function (out) {
      var text = out && out.text ? out.text : '';
      post({ id: id, type: 'done', text: text });
    }, function (err) {
      post({ id: id, type: 'error', error: errText(err) });
    });
    return;
  }

  if (m.type === 'load-tts') {
    loadTTS(id, m.model).then(function () {
      post({ id: id, type: 'done' });
    }, function (err) {
      post({ id: id, type: 'error', error: errText(err) });
    });
    return;
  }

  if (m.type === 'tts') {
    loadTTS(id, m.model).then(function (synth) {
      return synth(m.text);
    }).then(function (out) {
      var audio = new Float32Array(out.audio);
      post({ id: id, type: 'done', audio: audio, sampling_rate: out.sampling_rate }, [audio.buffer]);
    }, function (err) {
      post({ id: id, type: 'error', error: errText(err) });
    });
    return;
  }

  post({ id: id, type: 'error', error: 'Unknown request: ' + m.type });
};

post({ type: 'ready' });
