importScripts(
  "demuxer_mp4.js",
  "renderer_2d.js",
  "renderer_webgl.js",
  "renderer_webgpu.js"
);

// Status UI. Messages are batched per animation frame.
let pendingStatus = null;

function setStatus(type, message) {
  if (pendingStatus) {
    pendingStatus[type] = message;
  } else {
    pendingStatus = { [type]: message };
    self.requestAnimationFrame(statusAnimationFrame);
  }
}

function statusAnimationFrame() {
  self.postMessage(pendingStatus);
  pendingStatus = null;
}

// Rendering. Drawing is limited to once per animation frame.
let renderer = null;
let startTime = null;
let frameCount = 0;
let pendingFrames = [];
let underflow = true;
let baseTime = 0;
let x = 0;

const chunkTransform = new TransformStream();
const chunkWriter = chunkTransform.writable.getWriter();
const chunkReader = chunkTransform.readable.getReader();

function handleFrame(frame) {
  pendingFrames.push(frame);
  if (underflow) setTimeout(renderFrame, 0);
}

function calculateTimeUntilNextFrame(timestamp) {
  if (baseTime == 0) baseTime = performance.now();
  let mediaTime = performance.now() - baseTime;
  return Math.max(0, timestamp / 1000 - mediaTime);
}

async function renderFrame() {
  underflow = pendingFrames.length == 0;
  if (underflow) return;

  const frame = pendingFrames.shift();

  // Based on the frame's timestamp calculate how much of real time waiting
  // is needed before showing the next frame.
  const timeUntilNextFrame = calculateTimeUntilNextFrame(frame.timestamp);
  await new Promise((r) => {
    setTimeout(r, timeUntilNextFrame);
  });
  renderAnimationFrame(frame);
  frame.close();

  // Immediately schedule rendering of the next frame
  setTimeout(renderFrame, 0);
}

function renderAnimationFrame(frame) {
  renderer.draw(frame);
}

// Startup.
function start({ dataUri, rendererName, canvas }) {
  // Pick a renderer to use.
  switch (rendererName) {
    case "2d":
      renderer = new Canvas2DRenderer(canvas);
      break;
    case "webgl":
      renderer = new WebGLRenderer(rendererName, canvas);
      break;
    case "webgl2":
      renderer = new WebGLRenderer(rendererName, canvas);
      break;
    case "webgpu":
      renderer = new WebGPURenderer(canvas);
      break;
  }

  // Set up a VideoDecoer.
  const decoder = new VideoDecoder({
    output(frame) {
      // Update statistics.
      if (startTime == null) {
        startTime = performance.now();
      } else {
        const elapsed = (performance.now() - startTime) / 1000;
        const fps = ++frameCount / elapsed;
        setStatus("render", `${fps.toFixed(0)} fps`);
      }

      // Schedule the frame to be rendered.
      handleFrame(frame);
    },
    error(e) {
      setStatus("decode", e);
    },
  });

  setInterval(() => {
    if (pendingFrames.length < 100) {
      chunkReader.read().then(({ value: chunk }) => decoder.decode(chunk));
    }
  }, 10);

  let firstChunk = true;
  // Fetch and demux the media data.
  const demuxer = new MP4Demuxer(dataUri, {
    onConfig(config) {
      setStatus(
        "decode",
        `${config.codec} @ ${config.codedWidth}x${config.codedHeight}`
      );
      decoder.configure(config);
    },
    onChunk(chunk) {
      // (chunk)(chunk);
      chunkWriter.write(chunk);
    },
    setStatus,
  });
}

// Listen for the start request.
self.addEventListener("message", (message) => start(message.data), {
  once: true,
});
