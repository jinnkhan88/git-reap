import { describe, expect, test } from "bun:test";
import { MOUSE_DISABLE_SEQ } from "../src/tui/index.js";

describe("TUI exit guard (mouse-tracking leak)", () => {
  test("exit sequence disables every mouse mode + restores cursor", () => {
    // SGR mouse modes that produce the ESC[<b>;<x>;<y>M garbage on the
    // console after an unclean exit; all must be turned off on exit.
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?1000l"); // X10
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?1002l"); // button-event (drag)
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?1003l"); // any-motion
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?1006l"); // SGR coordinates
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?1015l"); // urxvt variant
    expect(MOUSE_DISABLE_SEQ).toContain("\x1b[?25h"); // show cursor
  });
});
