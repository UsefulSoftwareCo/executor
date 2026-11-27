import { Atom, type AtomRegistry } from "effect/reactivity";

export const nodeKey = (atom: Atom.Atom<unknown>) =>
  Atom.isSerializable(atom) ? atom[Atom.SerializableTypeId].key : atom;

export const loadedValue = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
): A | undefined => {
  const node = registry.getNodes().get(nodeKey(atom));
  if (node === undefined || node.currentState() !== "valid") return undefined;
  return node.value() as A;
};
