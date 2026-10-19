// Regenerates t/data/json-oracle.json: what JSON.parse and JSON.stringify make of each
// input, as Node (the reference implementation's runtime) says. Run from perl/:
//   node maint/oracle-json.mjs > t/data/json-oracle.json
const texts = [
  '{}', '[]', '{"a":{},"b":[],"c":[{}],"d":[[]]}', '[1,[2,[3,{"x":null}]]]',
  '{"b":1,"a":2,"10":3,"2":4,"-1":5,"01":6,"4294967294":7,"4294967295":8}',
  '{"a":1,"b":2,"a":3}', '{"__proto__":1,"constructor":2}',
  '"\\u0000\\u0001\\u001f\\b\\f\\n\\r\\t\\"\\\\\\/\\u007f\\u2028\\u2029"',
  '"plain / slash and é € 😀 日本"',
  '"\\ud800"', '"\\udc00x"', '"\\ud83d\\ude00"', '"\\uD83D"',
  'true', 'false', 'null', '[true,false,null]',
  '0', '-0', '1', '-1', '1.5', '0.1', '0.2', '1e21', '1e20', '123456789012345680000',
  '1e-7', '1.234e-7', '0.000001', '0.0000012', '5e-324', '1.7976931348623157e308',
  '100', '9007199254740993', '18446744073709551615', '-1.5e-10', '3.14159', '1E+2', '2.50',
  '1e999', '-1e999', '123e-20', '1.0000000000000002', '4.35', '0.30000000000000004',
  ' \t\n\r[ 1 , 2 ]\n ', '{"k":"v","n":{"deep":{"deeper":[1,"two",{"three":3}]}}}',
];
const bad = [
  '', ' ', '{', '{"a"', '{"a":', '{"a":1', '{"a":1,', '{a:1}', '[1,]', '[1 2]', '{"a":1}x',
  '"abc', '"a\u0001"', '"\\x"', '-', '1.', '1e', '01', 'tru', 'nul', '{"a" 1}', '[',
  '﻿{}', '{"a":1 "b":2}', '"\\u12g4"', 'x', '{"aé":"bü"x}', '\n\n  {"a":tru}',
  '[1,2', '{"a":1,"b"', 'trux', '[tru]', '[nulx]', '{"a":1}"x"', '[1]]', '\r\n{\r\n"a" 1}',
  '\r{"a" 1}', '[-a]', '[1.e5]', '[1e+]', '["\\u12"]', '["\t"]', '{"a":1,"a"}', '[1,2,3',
  '{""', '"x\\', '["x\\', '["x\\u', '[-', '[0x1]', '[.5]', '[+1]', '[1}', '{"a":1]', '{]',
  '[,]', '{"a":01}', '[00]', '[-01]', '[1.5.5]', '[1e5e5]', '  x',
  'x1,1,1,1,1,1,1,1,1,1,', '[1,1,x,1,1,1,1,1,1,1,', '[1,1,1,1,1,1,1,x,1,1,',
  '[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,x', '[1,1,1,1,1,1,1,x,1,1,1,1,1,1,1,1,1,1,1,1',
  '[\n1,\n2,x]', '{"sources": {"a": {"git": "x",}}}', 'falsy', '[nan]', '" " x',
  '{"😀": 1 x}', '[1] // comment', '{\n  "a": 1,\n  "b": 2,\n}\n',
];
const out = { stringify: [], errors: [] };
for (const text of texts) {
  const v = JSON.parse(text);
  out.stringify.push({ text, pretty: JSON.stringify(v, null, 2), compact: JSON.stringify(v) });
}
for (const text of bad) {
  try {
    JSON.parse(text);
    throw new Error(`parsed: ${text}`);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    out.errors.push({ text, message: e.message });
  }
}
console.log(JSON.stringify(out, null, 1));
