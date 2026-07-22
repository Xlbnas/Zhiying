import {interpolate, spring} from 'remotion';
import type {SpringConfig} from 'remotion';
import {motion} from '../design/tokens';

export const safeInterpolate = (
  frame: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
): number =>
  interpolate(frame, inputRange, outputRange, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

export const fadeIn = (frame: number, start: number, duration: number = motion.enterFrames) =>
  safeInterpolate(frame, [start, start + duration], [0, 1]);

export const drawProgress = (
  frame: number,
  start: number,
  duration: number = motion.drawFrames,
) => safeInterpolate(frame, [start, start + duration], [0, 1]);

export const calmSpring = (
  frame: number,
  fps: number,
  delay = 0,
  config?: Partial<SpringConfig>,
) =>
  spring({
    frame: frame - delay,
    fps,
    config: {
      damping: motion.damping,
      stiffness: motion.stiffness,
      mass: motion.mass,
      ...config,
    },
  });

export const seconds = (value: number, fps: number) => Math.round(value * fps);
