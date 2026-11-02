"use client";

import { useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { saveCode } from "../../../actions";

export function CodeEditor({
  name,
  initialCode,
}: {
  name: string;
  initialCode: string;
}) {
  const formRef = useRef<HTMLFormElement | null>(null);
  const [code, setCode] = useState(initialCode);

  const saveKeymap = Prec.highest(
    keymap.of([
      {
        key: "Mod-s",
        run: () => {
          formRef.current?.requestSubmit();
          return true;
        },
      },
    ]),
  );

  return (
    <form ref={formRef} action={saveCode} className="flex min-h-0 flex-1 flex-col">
      <input type="hidden" name="name" value={name} />
      <input type="hidden" name="code" value={code} />

      {/* shortcut: the max-h assumes ~24rem of page chrome (header, title, tabs, Save row, padding) so the Save row stays on screen; re-measure if the layout above changes height. */}
      <div className="min-h-[320px] max-h-[calc(100vh-24rem)] flex-1 overflow-hidden rounded border border-neutral-700">
        <CodeMirror
          value={code}
          onChange={setCode}
          theme="dark"
          extensions={[javascript({ typescript: false }), saveKeymap]}
          basicSetup={{
            lineNumbers: true,
            foldGutter: false,
            highlightActiveLine: true,
            highlightActiveLineGutter: true,
            autocompletion: false,
          }}
          height="100%"
          style={{ height: "100%" }}
        />
      </div>

      <div className="mt-2 flex items-center justify-between">
        <p className="text-xs text-neutral-500">
          Ctrl/Cmd+S to save. Globals: <span className="font-mono">req</span>,{" "}
          <span className="font-mono">ctx.env</span>,{" "}
          <span className="font-mono">ctx.db.query</span>,{" "}
          <span className="font-mono">fetch</span>,{" "}
          <span className="font-mono">Response</span>.
        </p>
        <button
          type="submit"
          className="rounded border border-neutral-700 bg-neutral-800 px-4 py-1.5 text-sm hover:bg-neutral-700"
        >
          Save
        </button>
      </div>
    </form>
  );
}
