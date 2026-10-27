import { expect, test } from 'vitest';
import { placeRoomNode, roomLayoutBounds } from '../roomNetworkLayout';

test('new connected nodes get deterministic positions without moving existing nodes or expanding the view', () => {
    const positions = new Map([['a', { x: -50, y: 30 }], ['b', { x: 80, y: -20 }]]);
    const before = JSON.stringify([...positions]);
    const bounds = roomLayoutBounds(positions);
    const position = placeRoomNode('new', ['a'], positions, bounds);
    expect(placeRoomNode('new', ['a'], positions, bounds)).toEqual(position);
    expect(JSON.stringify([...positions])).toBe(before);
    expect(position.x).toBeGreaterThan(bounds.x[0]);
    expect(position.x).toBeLessThan(bounds.x[1]);
    expect(position.y).toBeGreaterThan(bounds.y[0]);
    expect(position.y).toBeLessThan(bounds.y[1]);
});
