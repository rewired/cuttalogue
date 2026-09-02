// Deterministic spatial interpretation of CUTTAlogue Camera-lane segments.
// This is deliberately independent of the DOM and WebGL: the embedded
// visualizer, JSON export and future MCP service must all evaluate the same
// path contract rather than maintaining parallel animation state.
(function (MSE) {
  'use strict';

  const DEFAULT_CAMERA = Object.freeze({
    position: Object.freeze([0, 1.6, 4]),
    yaw: 0,
    pitch: 0,
    roll: 0,
    focalLengthMm: 35,
  });

  const DEFAULT_PROFILE = Object.freeze({
    defaultDistanceMeters: 1,
    smallDistanceMeters: 0.5,
    largeDistanceMeters: 2,
    defaultAngleDegrees: 20,
    smallAngleDegrees: 10,
    largeAngleDegrees: 45,
    zoomInFactor: 0.7,
    zoomOutFactor: 1.4,
  });

  const clamp = (value, minimum, maximum) => Math.max(minimum, Math.min(maximum, value));
  const lerp = (start, end, amount) => start + (end - start) * amount;
  const degreesToRadians = (degrees) => degrees * Math.PI / 180;

  function finiteNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function finiteVector(value, fallback) {
    if (!Array.isArray(value) || value.length !== 3) return [...fallback];
    const vector = value.map(Number);
    return vector.every(Number.isFinite) ? vector : [...fallback];
  }

  function normalizeCamera(camera) {
    const source = camera || {};
    return {
      position: finiteVector(source.position, DEFAULT_CAMERA.position),
      yaw: finiteNumber(source.yaw, DEFAULT_CAMERA.yaw),
      pitch: finiteNumber(source.pitch, DEFAULT_CAMERA.pitch),
      roll: finiteNumber(source.roll, DEFAULT_CAMERA.roll),
      focalLengthMm: Math.max(1, finiteNumber(source.focalLengthMm, DEFAULT_CAMERA.focalLengthMm)),
    };
  }

  function cloneCamera(camera) {
    return { ...camera, position: [...camera.position] };
  }

  // Basis convention is inherited from Shot Visualizer: yaw 0 looks down -Z,
  // positive yaw turns right, and positive pitch looks up.
  function cameraBasis(camera) {
    const cosineYaw = Math.cos(camera.yaw);
    const sineYaw = Math.sin(camera.yaw);
    const cosinePitch = Math.cos(camera.pitch);
    const sinePitch = Math.sin(camera.pitch);
    const baseRight = [cosineYaw, 0, sineYaw];
    const baseUp = [-sineYaw * sinePitch, cosinePitch, cosineYaw * sinePitch];
    const cosineRoll = Math.cos(camera.roll || 0);
    const sineRoll = Math.sin(camera.roll || 0);
    return {
      forward: [sineYaw * cosinePitch, sinePitch, -cosineYaw * cosinePitch],
      right: baseRight.map((value, index) => value * cosineRoll + baseUp[index] * sineRoll),
      up: baseUp.map((value, index) => value * cosineRoll - baseRight[index] * sineRoll),
    };
  }

  function addScaled(position, axis, distance) {
    return position.map((value, index) => value + axis[index] * distance);
  }

  function lookAt(camera, target) {
    const delta = target.map((value, index) => value - camera.position[index]);
    const horizontal = Math.hypot(delta[0], delta[2]);
    camera.yaw = Math.atan2(delta[0], -delta[2]);
    camera.pitch = Math.atan2(delta[1], horizontal);
  }

  function resolveTarget(segment, targets, defaultTarget, startPose, warnings, segmentIndex) {
    const targetName = String(segment.target || '').trim();
    const candidate = targetName ? targets[targetName] : defaultTarget;
    const rawPosition = candidate && (candidate.position || candidate);
    if (Array.isArray(rawPosition) && rawPosition.length === 3 && rawPosition.every((value) => Number.isFinite(Number(value)))) {
      return rawPosition.map(Number);
    }
    warnings.push({ code: targetName ? 'unresolved_target' : 'missing_target', segmentIndex, value: targetName || null });
    return addScaled(startPose.position, cameraBasis(startPose).forward, 3);
  }

  function amplitudeValue(amplitude, profile, kind) {
    const suffix = kind === 'angle' ? 'AngleDegrees' : 'DistanceMeters';
    if (amplitude === 'small') return profile[`small${suffix}`];
    if (amplitude === 'large') return profile[`large${suffix}`];
    return profile[`default${suffix}`];
  }

  function directionSign(direction, positiveName, negativeName, warnings, segmentIndex) {
    if (direction === positiveName) return 1;
    if (direction === negativeName) return -1;
    if (direction) warnings.push({ code: 'unsupported_direction', segmentIndex, value: direction });
    else warnings.push({ code: 'missing_direction', segmentIndex });
    return 1;
  }

  function parseFocalLength(value, warnings, segmentIndex) {
    if (value === undefined || value === null || value === '') return null;
    const match = /^\s*(\d+(?:\.\d+)?)\s*(?:mm)?\s*$/i.exec(String(value));
    if (!match || Number(match[1]) <= 0) {
      warnings.push({ code: 'invalid_focal_length', segmentIndex, value });
      return null;
    }
    return Number(match[1]);
  }

  function normalizeProfile(profile) {
    const merged = { ...DEFAULT_PROFILE, ...(profile || {}) };
    Object.keys(DEFAULT_PROFILE).forEach((key) => {
      merged[key] = Math.max(0.0001, finiteNumber(merged[key], DEFAULT_PROFILE[key]));
    });
    return merged;
  }

  function endPoseForSegment(startPose, segment, profile, targets, defaultTarget, warnings, segmentIndex) {
    const endPose = cloneCamera(startPose);
    const movement = segment.movement || 'static_shot';
    const basis = cameraBasis(startPose);
    const distance = amplitudeValue(segment.amplitude, profile, 'distance');
    const angle = degreesToRadians(amplitudeValue(segment.amplitude, profile, 'angle'));
    const authoredFocalLength = parseFocalLength(segment.focalLength, warnings, segmentIndex);

    if (authoredFocalLength !== null) endPose.focalLengthMm = authoredFocalLength;

    switch (movement) {
      case 'static_shot':
        break;
      case 'push_in':
        endPose.position = addScaled(startPose.position, basis.forward, distance);
        break;
      case 'pull_out':
        endPose.position = addScaled(startPose.position, basis.forward, -distance);
        break;
      case 'truck': {
        const sign = directionSign(segment.direction, 'right', 'left', warnings, segmentIndex);
        endPose.position = addScaled(startPose.position, basis.right, distance * sign);
        break;
      }
      case 'pedestal_up':
        endPose.position = addScaled(startPose.position, [0, 1, 0], distance);
        break;
      case 'pedestal_down':
        endPose.position = addScaled(startPose.position, [0, 1, 0], -distance);
        break;
      case 'pan': {
        const sign = directionSign(segment.direction, 'right', 'left', warnings, segmentIndex);
        endPose.yaw += angle * sign;
        break;
      }
      case 'tilt_up':
        endPose.pitch = clamp(startPose.pitch + angle, -Math.PI / 2, Math.PI / 2);
        break;
      case 'tilt_down':
        endPose.pitch = clamp(startPose.pitch - angle, -Math.PI / 2, Math.PI / 2);
        break;
      case 'roll_cw':
        endPose.roll -= angle;
        break;
      case 'roll_ccw':
        endPose.roll += angle;
        break;
      case 'zoom_in':
        if (authoredFocalLength === null) endPose.focalLengthMm = startPose.focalLengthMm / profile.zoomInFactor;
        break;
      case 'zoom_out':
        if (authoredFocalLength === null) endPose.focalLengthMm = startPose.focalLengthMm / profile.zoomOutFactor;
        break;
      case 'tracking_shot': {
        const target = resolveTarget(segment, targets, defaultTarget, startPose, warnings, segmentIndex);
        let axis = basis.right;
        let sign = 1;
        if (segment.direction === 'left') sign = -1;
        else if (segment.direction === 'forward') axis = basis.forward;
        else if (segment.direction === 'backward') { axis = basis.forward; sign = -1; }
        else if (segment.direction === 'up') axis = [0, 1, 0];
        else if (segment.direction === 'down') { axis = [0, 1, 0]; sign = -1; }
        else if (segment.direction !== 'right') directionSign(segment.direction, 'right', 'left', warnings, segmentIndex);
        endPose.position = addScaled(startPose.position, axis, distance * sign);
        lookAt(endPose, target);
        break;
      }
      case 'arc_shot': {
        const target = resolveTarget(segment, targets, defaultTarget, startPose, warnings, segmentIndex);
        const sign = directionSign(segment.direction, 'right', 'left', warnings, segmentIndex);
        const relative = startPose.position.map((value, index) => value - target[index]);
        const cosine = Math.cos(angle * sign);
        const sine = Math.sin(angle * sign);
        endPose.position = [
          target[0] + relative[0] * cosine + relative[2] * sine,
          startPose.position[1],
          target[2] - relative[0] * sine + relative[2] * cosine,
        ];
        lookAt(endPose, target);
        break;
      }
      default:
        warnings.push({ code: 'movement_not_implemented', segmentIndex, value: movement });
        break;
    }
    return endPose;
  }

  function compile(cameraSegments, options = {}) {
    const duration = Math.max(0, finiteNumber(options.durationSeconds, Infinity));
    const profile = normalizeProfile(options.profile);
    const initialPose = normalizeCamera(options.initialCamera);
    const targets = options.targets && typeof options.targets === 'object' ? options.targets : {};
    const defaultTarget = options.defaultTarget || null;
    const warnings = [];
    const source = Array.isArray(cameraSegments) ? cameraSegments : [];
    const enabled = source
      .map((segment, sourceIndex) => ({ ...segment, sourceIndex }))
      .filter((segment) => segment.enabled !== false)
      .sort((a, b) => finiteNumber(a.startSeconds, 0) - finiteNumber(b.startSeconds, 0));

    const segments = [];
    let currentPose = cloneCamera(initialPose);
    let previousEnd = 0;

    enabled.forEach((segment) => {
      const startSeconds = clamp(finiteNumber(segment.startSeconds, 0), 0, duration);
      const endSeconds = clamp(finiteNumber(segment.endSeconds, startSeconds), 0, duration);
      if (!(endSeconds > startSeconds)) {
        warnings.push({ code: 'invalid_time_range', segmentIndex: segment.sourceIndex });
        return;
      }
      if (startSeconds < previousEnd) {
        warnings.push({ code: 'overlapping_segments', segmentIndex: segment.sourceIndex });
      }
      const startPose = cloneCamera(currentPose);
      const endPose = endPoseForSegment(startPose, segment, profile, targets, defaultTarget, warnings, segment.sourceIndex);
      segments.push({
        sourceIndex: segment.sourceIndex,
        startSeconds,
        endSeconds,
        speed: segment.speed || '',
        movement: segment.movement || 'static_shot',
        startPose,
        endPose,
      });
      currentPose = cloneCamera(endPose);
      previousEnd = Math.max(previousEnd, endSeconds);
    });

    return { version: 1, initialPose, durationSeconds: duration, segments, warnings };
  }

  function easingAmount(amount, speed) {
    const t = clamp(amount, 0, 1);
    const normalized = String(speed || '').trim().toLowerCase();
    if (normalized === 'linear' || normalized === 'constant') return t;
    if (normalized === 'fast') return 1 - (1 - t) * (1 - t);
    if (normalized === 'slow') return t * t;
    return t * t * (3 - 2 * t);
  }

  function interpolatePose(startPose, endPose, amount) {
    return {
      position: startPose.position.map((value, index) => lerp(value, endPose.position[index], amount)),
      yaw: lerp(startPose.yaw, endPose.yaw, amount),
      pitch: lerp(startPose.pitch, endPose.pitch, amount),
      roll: lerp(startPose.roll, endPose.roll, amount),
      focalLengthMm: lerp(startPose.focalLengthMm, endPose.focalLengthMm, amount),
    };
  }

  function quaternionFromAngles(yaw, pitch, roll) {
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    const cr = Math.cos(roll / 2);
    const sr = Math.sin(roll / 2);
    return [
      -cy * sp * cr + sy * cp * sr,
      sy * cp * cr + cy * sp * sr,
      sy * sp * cr + cy * cp * sr,
      cy * cp * cr - sy * sp * sr,
    ];
  }

  function resultForPose(pose, segmentIndex, warnings) {
    return {
      ...cloneCamera(pose),
      rotationQuaternion: quaternionFromAngles(pose.yaw, pose.pitch, pose.roll),
      segmentIndex,
      warnings: [...warnings],
    };
  }

  function evaluate(plan, timeSeconds) {
    if (!plan || !Array.isArray(plan.segments)) throw new TypeError('A compiled camera path is required.');
    const time = clamp(finiteNumber(timeSeconds, 0), 0, plan.durationSeconds);
    let heldPose = plan.initialPose;
    for (let index = 0; index < plan.segments.length; index += 1) {
      const segment = plan.segments[index];
      if (time < segment.startSeconds) return resultForPose(heldPose, null, plan.warnings);
      const isFinalEndpoint = index === plan.segments.length - 1 && time === segment.endSeconds;
      if (time < segment.endSeconds || isFinalEndpoint) {
        const rawAmount = (time - segment.startSeconds) / (segment.endSeconds - segment.startSeconds);
        const pose = interpolatePose(segment.startPose, segment.endPose, easingAmount(rawAmount, segment.speed));
        return resultForPose(pose, segment.sourceIndex, plan.warnings);
      }
      heldPose = segment.endPose;
    }
    return resultForPose(heldPose, null, plan.warnings);
  }

  MSE.cameraPath = {
    DEFAULT_CAMERA,
    DEFAULT_PROFILE,
    cameraBasis,
    compile,
    evaluate,
    normalizeCamera,
    quaternionFromAngles,
  };
})(window.MSE = window.MSE || {});
