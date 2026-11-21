import test from "node:test";
import assert from "node:assert/strict";
import { cleanNotes, getNotes, parseMIDI, putVar, readVar, writeMIDI } from "../src/midi.js";

test("variable-length values round trip", () => {
  for (const value of [0, 127, 128, 255, 16383, 16384, 0x0fffffff]) {
    const bytes = putVar(value);
    assert.equal(readVar(Uint8Array.from(bytes), { i: 0 }), value);
  }
});

test("cleanNotes keeps the highest active pitch and restores lower note tails", () => {
  const result = cleanNotes([
    { id: 0, start: 0, end: 100, pitch: 48, velocity: 90, channel: 0 },
    { id: 1, start: 25, end: 75, pitch: 72, velocity: 80, channel: 0 }
  ]);
  assert.deepEqual(result.map(note => [note.pitch, note.start, note.end]), [
    [48, 0, 25], [72, 25, 75], [48, 75, 100]
  ]);
});

test("equal pitches favor the earlier note", () => {
  const result = cleanNotes([
    { id: 0, start: 0, end: 50, pitch: 60, velocity: 90, channel: 0 },
    { id: 1, start: 10, end: 40, pitch: 60, velocity: 80, channel: 0 }
  ]);
  assert.deepEqual(result.map(note => [note.id, note.start, note.end]), [[0, 0, 50]]);
});

test("MIDI can be parsed, cleaned and written again", async () => {
  const original = {
    format: 0, division: 480,
    tracks: [{
      name: "Test",
      events: [
        { tick: 0, kind: "meta", type: 3, data: new TextEncoder().encode("Test"), order: 0 },
        { tick: 0, kind: "channel", status: 0x90, channel: 0, high: 0x90, d1: 48, d2: 90, order: 1 },
        { tick: 120, kind: "channel", status: 0x90, channel: 0, high: 0x90, d1: 72, d2: 90, order: 2 },
        { tick: 240, kind: "channel", status: 0x80, channel: 0, high: 0x80, d1: 72, d2: 0, order: 3 },
        { tick: 360, kind: "channel", status: 0x80, channel: 0, high: 0x80, d1: 48, d2: 0, order: 4 },
        { tick: 360, kind: "meta", type: 0x2f, data: new Uint8Array(), order: 5 }
      ]
    }]
  };
  const blob = writeMIDI(original, new Set([0]));
  const parsed = parseMIDI(await blob.arrayBuffer());
  const notes = getNotes(parsed.tracks[0]);
  assert.deepEqual(notes.map(note => [note.pitch, note.start, note.end]), [
    [48, 0, 120], [72, 120, 240], [48, 240, 360]
  ]);
  assert.equal(parsed.tracks[0].events.filter(event => event.kind === "meta" && event.type === 0x2f).length, 1);
});

test("rejects unsupported format 2", () => {
  const bytes = new Uint8Array([77,84,104,100,0,0,0,6,0,2,0,1,1,224]);
  assert.throws(() => parseMIDI(bytes.buffer), /format 2/);
});
