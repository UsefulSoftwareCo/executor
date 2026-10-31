/** Reading what a registry already holds, without JSX, so plain TypeScript modules can import it. */
import { Atom, type AtomRegistry } from "effect/reactivity";

/** The key a registry stores an atom's node under. */
export const nodeKey = (atom: Atom.Atom<unknown>) =>
  Atom.isSerializable(atom) ? atom[Atom.SerializableTypeId].key : atom;

/**
 * The value `atom` holds if something already read it, without starting a read. A read can act on
 * data another page loaded, such as the list it was opened from, at no cost when there is none.
 */
export const loadedValue = <A>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
): A | undefined => {
  const node = registry.getNodes().get(nodeKey(atom));
  // Reading a node that is not valid would compute it, which starts the read.
  if (node === undefined || node.currentState() !== "valid") return undefined;
  // SAFETY: the registry stores each atom's node under that atom's key.
  return node.value() as A;
};
