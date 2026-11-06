import * as fs from "fs";

// Dependency-less version of edit-json-file package
export default function editJSONFile(filename) {
  let data = JSON.parse(fs.readFileSync(filename, "utf8") || "{}");
  const keys = (key) => key.replace(/\\\./g, "\0").split(".").map((part) => part.replace(/\0/g, "."));
  const parentFor = (key, create = false) => {
    const parts = keys(key);
    const lastKey = parts.pop();
    const parent = parts.reduce((current, part) => {
      if (create) current[part] ??= {};
      return current?.[part];
    }, data);

    return [parent, lastKey];
  };
  const file = {
    get(key) {
      return key ? keys(key).reduce((current, part) => current?.[part], data) : data;
    },
    set(key, value) {
      const [parent, lastKey] = parentFor(key, true);
      parent[lastKey] = value;
      return file.save();
    },
    unset(key) {
      const [parent, lastKey] = parentFor(key);
      if (parent && Object.hasOwn(parent, lastKey)) delete parent[lastKey];
      return file.save();
    },
    append(key, value) {
      const list = file.get(key) ?? [];
      file.set(key, [...list, value]);
      return file;
    },
    pop(key) {
      file.get(key)?.pop();
      return file.save();
    },
    read() {
      data = JSON.parse(fs.readFileSync(filename, "utf8") || "{}");
      return data;
    },
    save() {
      fs.writeFileSync(filename, `${JSON.stringify(data, null, 2)}\n`);
      return file;
    },
    toObject() {
      return data;
    },
    toString() {
      return `${JSON.stringify(data, null, 2)}\n`;
    },
  };

  return file;
}
