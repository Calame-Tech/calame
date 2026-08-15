// Unit tests for the graph layout order persistence (ConfigGraphView).
// reconcileOrder is the pure core: a saved id order merged against the live
// (barycenter-computed) order — stale ids dropped, new ids inserted right
// after their closest preceding computed neighbor.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  GRAPH_ORDER_STORAGE_KEY,
  clearGraphOrder,
  loadGraphOrder,
  reconcileOrder,
  saveGraphOrder,
} from './graph-order.js';

describe('reconcileOrder', () => {
  it('returns the computed order when nothing is saved', () => {
    expect(reconcileOrder(undefined, ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
    expect(reconcileOrder([], ['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('drops saved ids that no longer exist, keeping the saved order', () => {
    // x and y are stale; survivors keep the saved relative order [c, a] and
    // the new-to-saved id b slots in after its computed predecessor a.
    expect(reconcileOrder(['x', 'c', 'y', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('inserts new ids at their computed position', () => {
    // b and d are new; each slots in right after its computed predecessor.
    expect(reconcileOrder(['a', 'c'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
  });

  it('inserts a new id with no present computed predecessor at the front', () => {
    expect(reconcileOrder(['b'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('handles stale ids and new ids together', () => {
    // User order [c, a] survives (x dropped); new b lands after its computed
    // predecessor a.
    expect(reconcileOrder(['x', 'c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });

  it('preserves a fully-custom order when the model is unchanged', () => {
    expect(reconcileOrder(['c', 'a', 'b'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });
});

describe('graph order storage', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('round-trips a saved order', () => {
    const order = { sources: ['s:a'], configs: ['c:x', 'c:y'], servers: ['m:1'] };
    saveGraphOrder(order);
    expect(loadGraphOrder()).toEqual(order);
    clearGraphOrder();
    expect(loadGraphOrder()).toBeNull();
  });

  it('returns null for absent, corrupt or mis-shaped payloads', () => {
    expect(loadGraphOrder()).toBeNull();

    localStorage.setItem(GRAPH_ORDER_STORAGE_KEY, '{not json');
    expect(loadGraphOrder()).toBeNull();

    localStorage.setItem(
      GRAPH_ORDER_STORAGE_KEY,
      JSON.stringify({ sources: ['a'], configs: 'nope', servers: [] }),
    );
    expect(loadGraphOrder()).toBeNull();

    localStorage.setItem(GRAPH_ORDER_STORAGE_KEY, JSON.stringify(['a', 'b']));
    expect(loadGraphOrder()).toBeNull();
  });
});
