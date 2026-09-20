import assert from 'node:assert/strict';
import { livePhotoFinished } from '../src/features/workspace/live-photo-playback.ts';
assert(livePhotoFinished({ time: 71 / 24, duration: 3, paused: true }, true), '24 fps last frame');
assert(livePhotoFinished({ time: 44 / 15, duration: 3, paused: true, frameRate: 15 }, true), '15 fps last frame');
assert(!livePhotoFinished({ time: 3, duration: 3, paused: true }, false), 'startup snapshots cannot end a new play');
assert(!livePhotoFinished({ time: 1, duration: 3, paused: true }, true), 'mid-clip pause');
assert(!livePhotoFinished({ time: 2.99, duration: 3, paused: false }, true), 'do not hide a playing frame');
assert(!livePhotoFinished({ time: 0, duration: 0, paused: true }, true), 'loading metadata');
console.log('Live Photo completion: 24/15 fps, startup, pause, playback and missing metadata passed.');
