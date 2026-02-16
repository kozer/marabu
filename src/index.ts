import canonicalize from "canonicalize";

export function hashObject(obj: any): string {
  const serialized = canonicalize(obj);
  if (serialized === undefined) {
    throw new Error("Failed to serialize object");
  }
  return serialized;
}

console.log(
  canonicalize({
    name: "Alice",
    age: 30,
    hobbies: ["reading", "hiking"],
    address: {
      street: "123 Main St",
      city: "Anytown",
      country: "USA",
    },
  }),
);
console.log(canonicalize(""));
console.log(canonicalize(undefined));

