// On-device body pose detection (MediaPipe Pose Landmarker). The model runs in
// the browser; the shopper's photo is never uploaded anywhere.
const WASM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'
const MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task'

let landmarkerPromise = null

function getLandmarker() {
  // Note: outputSegmentationMasks crashes this build in IMAGE mode, so we only use landmarks.
  landmarkerPromise ??= (async () => {
    const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision')
    const vision = await FilesetResolver.forVisionTasks(WASM)
    return PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL },
      runningMode: 'IMAGE',
      numPoses: 1,
    })
  })().catch((e) => {
    landmarkerPromise = null
    throw e
  })
  return landmarkerPromise
}

/** Returns 33 normalised landmarks ({x, y, v}) or null if no person was found. */
export async function detectPose(img) {
  const landmarker = await getLandmarker()
  const result = landmarker.detect(img)
  return result.landmarks?.[0]?.map(({ x, y, visibility }) => ({ x, y, v: visibility ?? 1 })) ?? null
}
