/**
 * Typed postMessage protocol for the replay parse worker.
 */

import type { ReplayFile } from './replay-format';

export type ReplayWorkerRequest = {
  type: 'parse';
  id: number;
  text: string;
  filename?: string;
};

export type ReplayWorkerOk = {
  type: 'ok';
  id: number;
  replay: ReplayFile;
  source: 'json' | 'csv';
};

export type ReplayWorkerErr = {
  type: 'error';
  id: number;
  error: string;
};

export type ReplayWorkerResponse = ReplayWorkerOk | ReplayWorkerErr;
