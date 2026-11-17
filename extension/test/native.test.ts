import assert from "node:assert/strict";
import test from "node:test";
import { Native } from "../src/native";

test("native transport correlates requests and bounds ordered chunk assembly", async () => {
  const listeners: ((value: unknown) => void)[] = [];
  const requests: Record<string, unknown>[] = [];
  const port = {
    onMessage: {
      addListener: (listener: (value: unknown) => void) =>
        listeners.push(listener),
    },
    onDisconnect: { addListener: () => {} },
    postMessage: (value: Record<string, unknown>) => requests.push(value),
    disconnect: () => {},
  };
  Object.assign(globalThis, {
    chrome: { runtime: { connectNative: () => port } },
  });
  const native = new Native();
  const pending = native.request("config.get");
  const reply = {
    version: 1,
    request_id: requests[0].request_id,
    result: { hello: "界" },
  };
  const bytes = Buffer.from(JSON.stringify(reply));
  const split = bytes.length - 3;
  for (const [index, part] of [
    bytes.subarray(0, split),
    bytes.subarray(split),
  ].entries()) {
    listeners[0]({
      type: "chunk",
      request_id: reply.request_id,
      index,
      total: 2,
      data: part.toString("base64"),
    });
  }
  assert.deepEqual(await pending, { hello: "界" });
  const invalid = native.request("list");
  listeners[0]({
    type: "chunk",
    request_id: requests[1].request_id,
    index: 1,
    total: 2,
    data: "YQ==",
  });
  await assert.rejects(invalid, /sequence/);
});

test("late events from an old native port cannot break a new connection", async () => {
  const makePort = () => {
    const messages: ((value: unknown) => void)[] = [];
    const disconnects: (() => void)[] = [];
    const requests: Record<string, unknown>[] = [];
    return {
      messages,
      disconnects,
      requests,
      onMessage: {
        addListener: (listener: (value: unknown) => void) =>
          messages.push(listener),
      },
      onDisconnect: {
        addListener: (listener: () => void) => disconnects.push(listener),
      },
      postMessage: (value: Record<string, unknown>) => requests.push(value),
      disconnect() {},
    };
  };
  const ports = [makePort(), makePort()];
  let next = 0;
  Object.assign(globalThis, {
    chrome: { runtime: { connectNative: () => ports[next++] } },
  });
  const native = new Native();
  let disconnected = 0;
  native.onDisconnect = () => {
    disconnected++;
  };
  const old = native.request("status");
  const rejected = assert.rejects(old, /reconnecting/);
  native.disconnect();
  await rejected;
  const current = native.request("status");
  ports[0].disconnects[0]();
  ports[0].messages[0]({
    version: 1,
    request_id: ports[1].requests[0].request_id,
    result: "stale",
  });
  ports[1].messages[0]({
    version: 1,
    request_id: ports[1].requests[0].request_id,
    result: { authenticated: false },
  });
  assert.deepEqual(await current, { authenticated: false });
  assert.equal(disconnected, 1);
});
