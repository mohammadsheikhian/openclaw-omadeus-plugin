import { describe, expect, it } from "vitest";
import {
  findNuggetRowByNumber,
  findNuggetRowByRoomId,
  readNuggetNumber,
  resolveTaskChannelRoomId,
} from "./nugget.api.js";

describe("readNuggetNumber", () => {
  it("reads only the display number field", () => {
    expect(readNuggetNumber({ id: 21819, number: 12255 })).toBe(12255);
    expect(readNuggetNumber({ id: 21819 })).toBeUndefined();
  });

  it("accepts string numbers", () => {
    expect(readNuggetNumber({ number: "111" })).toBe(111);
  });
});

describe("findNuggetRowByNumber", () => {
  it("picks the row whose number matches N### (not internal id)", () => {
    const rows = [
      { id: 1, number: 11107, title: "wrong" },
      { id: 21819, number: 12255, title: "match" },
    ] as Record<string, unknown>[];
    expect(findNuggetRowByNumber(rows, 12255)).toEqual(rows[1]);
    expect(findNuggetRowByNumber(rows, 12256)).toBeUndefined();
  });
});

describe("findNuggetRowByRoomId", () => {
  it("matches private, public, or shared room id", () => {
    const rows = [
      { number: 1, privateRoomId: 999 },
      { number: 2, publicRoomId: 118_031 },
      { number: 3, sharedRoomId: 5 },
    ] as Record<string, unknown>[];
    expect(findNuggetRowByRoomId(rows, 118_031)).toEqual(rows[1]);
    expect(findNuggetRowByRoomId(rows, 5)).toEqual(rows[2]);
    expect(findNuggetRowByRoomId(rows, 999)).toEqual(rows[0]);
    expect(findNuggetRowByRoomId(rows, 0)).toBeUndefined();
  });

  it("matches any *room* id field, including string values and unexpected keys", () => {
    const rows = [
      { number: 4, threadRoomId: 117_236 },
      { number: 5, privateRoomId: "222" },
    ] as Record<string, unknown>[];
    expect(findNuggetRowByRoomId(rows, 117_236)).toEqual(rows[0]);
    expect(findNuggetRowByRoomId(rows, 222)).toEqual(rows[1]);
    // Non-room numeric fields must not match, even when the value is equal.
    expect(findNuggetRowByRoomId([{ number: 117_236 }], 117_236)).toBeUndefined();
  });
});

describe("resolveTaskChannelRoomId", () => {
  it("prefers private room id for task delivery", () => {
    expect(resolveTaskChannelRoomId({ privateRoomId: 117961, publicRoomId: 117962 })).toBe(117961);
  });

  it("falls back through public/shared room ids", () => {
    expect(resolveTaskChannelRoomId({ publicRoomId: 117962 })).toBe(117962);
    expect(resolveTaskChannelRoomId({ sharedRoomId: 5555 })).toBe(5555);
  });
});
