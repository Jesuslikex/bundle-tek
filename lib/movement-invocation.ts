import type { MovementInstruction } from './tracked-wallet-transaction';

/** Reconstruct one recorded invocation only when every CPI ordinal/depth is present. */
export function movementInvocation(
  facts: MovementInstruction[],
  selected: MovementInstruction,
) {
  const outer = selected.outerInstructionIndex;
  if (!Number.isSafeInteger(outer) || outer! < 0)
    throw new Error('Caller index unavailable.');
  const roots = facts.filter(
    (i) => i.topLevel && i.outerInstructionIndex === outer,
  );
  if (roots.length !== 1) throw new Error('Caller root is ambiguous.');
  const root = roots[0];
  const children = facts
    .filter((i) => !i.topLevel && i.outerInstructionIndex === outer)
    .toSorted(
      (a, b) =>
        (a.innerInstructionIndex ?? -1) - (b.innerInstructionIndex ?? -1),
    );
  const parents = new Map<MovementInstruction, MovementInstruction>();
  const stack = [root];
  for (const [ordinal, child] of children.entries()) {
    const height = child.stackHeight;
    if (
      child.innerInstructionIndex !== ordinal ||
      !Number.isSafeInteger(height) ||
      height! < 2 ||
      height! > stack.length + 1
    )
      throw new Error('CPI ancestry is incomplete.');
    stack.length = height! - 1;
    parents.set(child, stack[height! - 2]);
    stack.push(child);
  }
  if (selected !== root && !parents.has(selected))
    throw new Error('Invocation not in caller group.');
  const inside = (child: MovementInstruction) => {
    let parent = parents.get(child);
    while (parent) {
      if (parent === selected) return true;
      parent = parents.get(parent);
    }
    return false;
  };
  return {
    root,
    parent: parents.get(selected) ?? null,
    descendants: children.filter(inside),
  };
}
