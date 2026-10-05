import { test } from "node:test";
import assert from "node:assert/strict";
import { applyChecklistTool, checklistSummary } from "../src/engine/checklist.ts";
import { fakeQuery, setup, until } from "./helpers.ts";
import type { ChecklistItem, Stage } from "../src/types.ts";

const ONE: Stage[] = [{ stage: "code", model: "m", effort: "medium" }];
const use = (name: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] }, ...extra });

test("Claude's to-do list is read from either of its list tools; other tools leave it alone", () => {
  let list: ChecklistItem[] = [];
  list = applyChecklistTool(list, "TaskCreate", { subject: "Build the page", description: "…", activeForm: "Building the page" })!;
  list = applyChecklistTool(list, "TaskCreate", { subject: "Add the animation", description: "…" })!;
  assert.deepEqual(list.map((x) => [x.id, x.text, x.status]), [["1", "Build the page", "pending"], ["2", "Add the animation", "pending"]]);
  list = applyChecklistTool(list, "TaskUpdate", { taskId: "1", status: "in_progress" })!;
  assert.deepEqual(checklistSummary(list), { done: 0, total: 2, now: "Building the page" }, "the card says what is being done, in its own words");
  list = applyChecklistTool(list, "TaskUpdate", { taskId: "1", status: "completed" })!;
  list = applyChecklistTool(list, "TaskUpdate", { taskId: "2", status: "deleted" })!;
  assert.deepEqual(checklistSummary(list), { done: 1, total: 1, now: null });
  // Claude Code numbers the next task 3 whatever was deleted before it; an id given out twice would
  // send its updates to the wrong row.
  list = applyChecklistTool(list, "TaskCreate", { subject: "Wire the form", description: "…" })!;
  list = applyChecklistTool(list, "TaskUpdate", { taskId: "3", status: "in_progress" })!;
  assert.deepEqual(checklistSummary(list), { done: 1, total: 2, now: "Wire the form" }, "the deleted item is not counted, and the new one has its own number");
  assert.equal(list.find((x) => x.id === "2")?.deleted, true);

  assert.equal(applyChecklistTool(list, "Read", { file_path: "x" }), null);
  assert.equal(applyChecklistTool(list, "TaskUpdate", { taskId: "9", status: "completed" }), null, "an id the board never saw changes nothing");
  assert.equal(checklistSummary([]), null);

  const written = applyChecklistTool(list, "TodoWrite", { todos: [{ content: "Write tests", status: "in_progress", activeForm: "Writing tests" }, { content: "Ship", status: "bogus" }] })!;
  assert.deepEqual(written.map((x) => x.status), ["in_progress", "pending"], "the older tool replaces the whole list; an unknown status is pending");
});

test("the card carries the running stage's list, a subagent's list stays off it, and a new stage starts clean", async () => {
  const q = fakeQuery({
    byCall: (i) =>
      i === 0
        ? {
            extra: [
              use("TaskCreate", { subject: "Build the page", description: "" }),
              use("TaskCreate", { subject: "Subagent's own step", description: "" }, { parent_tool_use_id: "toolu_sub" }),
              use("TaskUpdate", { taskId: "1", status: "completed" }),
            ],
          }
        : undefined,
  });
  const s = setup(q.fn);
  try {
    const t = s.repo.createTask({ project_id: s.project.id, title: "Landing page", mode: "supervised", pipeline: ONE });
    s.runner.queueTask(t.id);
    await until(() => s.repo.getTask(t.id)!.status === "review");
    assert.deepEqual(s.repo.getTask(t.id)!.checklist, [{ id: "1", text: "Build the page", status: "completed" }]);
    assert.equal(q.calls[0].options.env.CLAUDE_CODE_ENABLE_TODO_TOOLS, "1", "newer models ship with the list tools off");
    assert.deepEqual(s.repo.taskCards(s.project.id)[0].checklist.length, 1, "the board's card list has it too");

    s.runner.queueTask(t.id);
    await until(() => q.calls.length === 2 && s.repo.getTask(t.id)!.status === "review");
    assert.deepEqual(s.repo.getTask(t.id)!.checklist, [], "a fresh session has no list until it makes one");
  } finally {
    await s.cleanup();
  }
});
