import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import subagentsV2 from "../extensions/index.ts";
import { MAIL_TYPE, type MailDetails } from "../extensions/team-manager.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const render = (component: { render(width: number): string[] }) => component.render(100).map((line) => line.trimEnd());

test("inter-agent mail is compact by default and detailed when expanded", () => {
  let renderer: any;
  const pi = {
    registerTool() {},
    registerCommand() {},
    registerMessageRenderer(type: string, value: unknown) {
      assert.equal(type, MAIL_TYPE);
      renderer = value;
    },
    on() {},
  } as unknown as ExtensionAPI;
  subagentsV2(pi);

  const details: MailDetails = {
    source: "/root/researcher",
    target: "/root",
    type: "FINAL_ANSWER",
    payload: "Found the cause.\nDetails follow.",
  };
  const message = { content: "envelope", details } as any;

  assert.deepEqual(render(renderer(message, { expanded: false, outputPad: 0 }, theme)), [
    "",
    "✉ /root/researcher → /root FINAL_ANSWER: Found the cause. Details follow.",
    "",
  ]);
  assert.deepEqual(render(renderer(message, { expanded: true, outputPad: 0 }, theme)), [
    "",
    "Inter-agent message",
    "Type: FINAL_ANSWER",
    "From: /root/researcher",
    "To: /root",
    "",
    "Found the cause.",
    "Details follow.",
    "",
  ]);
});
