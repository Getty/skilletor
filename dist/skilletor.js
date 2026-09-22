// skilletor — generated bundle, do not edit. Rebuild with `npm run build`.
import { createRequire as __sk_createRequire } from "node:module";
const require = __sk_createRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod) => function __require2() {
  try {
    return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
  } catch (e) {
    throw mod = 0, e;
  }
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/nunjucks/src/lib.js
var require_lib = __commonJS({
  "node_modules/nunjucks/src/lib.js"(exports, module) {
    "use strict";
    var ArrayProto = Array.prototype;
    var ObjProto = Object.prototype;
    var escapeMap = {
      "&": "&amp;",
      '"': "&quot;",
      "'": "&#39;",
      "<": "&lt;",
      ">": "&gt;",
      "\\": "&#92;"
    };
    var escapeRegex = /[&"'<>\\]/g;
    var _exports = module.exports = {};
    function hasOwnProp(obj, k) {
      return ObjProto.hasOwnProperty.call(obj, k);
    }
    _exports.hasOwnProp = hasOwnProp;
    function lookupEscape(ch) {
      return escapeMap[ch];
    }
    function _prettifyError(path, withInternals, err) {
      if (!err.Update) {
        err = new _exports.TemplateError(err);
      }
      err.Update(path);
      if (!withInternals) {
        var old = err;
        err = new Error(old.message);
        err.name = old.name;
      }
      return err;
    }
    _exports._prettifyError = _prettifyError;
    function TemplateError(message, lineno, colno) {
      var err;
      var cause;
      if (message instanceof Error) {
        cause = message;
        message = cause.name + ": " + cause.message;
      }
      if (Object.setPrototypeOf) {
        err = new Error(message);
        Object.setPrototypeOf(err, TemplateError.prototype);
      } else {
        err = this;
        Object.defineProperty(err, "message", {
          enumerable: false,
          writable: true,
          value: message
        });
      }
      Object.defineProperty(err, "name", {
        value: "Template render error"
      });
      if (Error.captureStackTrace) {
        Error.captureStackTrace(err, this.constructor);
      }
      var getStack;
      if (cause) {
        var stackDescriptor = Object.getOwnPropertyDescriptor(cause, "stack");
        getStack = stackDescriptor && (stackDescriptor.get || function() {
          return stackDescriptor.value;
        });
        if (!getStack) {
          getStack = function getStack2() {
            return cause.stack;
          };
        }
      } else {
        var stack = new Error(message).stack;
        getStack = function getStack2() {
          return stack;
        };
      }
      Object.defineProperty(err, "stack", {
        get: function get() {
          return getStack.call(err);
        }
      });
      Object.defineProperty(err, "cause", {
        value: cause
      });
      err.lineno = lineno;
      err.colno = colno;
      err.firstUpdate = true;
      err.Update = function Update(path) {
        var msg = "(" + (path || "unknown path") + ")";
        if (this.firstUpdate) {
          if (this.lineno && this.colno) {
            msg += " [Line " + this.lineno + ", Column " + this.colno + "]";
          } else if (this.lineno) {
            msg += " [Line " + this.lineno + "]";
          }
        }
        msg += "\n ";
        if (this.firstUpdate) {
          msg += " ";
        }
        this.message = msg + (this.message || "");
        this.firstUpdate = false;
        return this;
      };
      return err;
    }
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(TemplateError.prototype, Error.prototype);
    } else {
      TemplateError.prototype = Object.create(Error.prototype, {
        constructor: {
          value: TemplateError
        }
      });
    }
    _exports.TemplateError = TemplateError;
    function escape(val) {
      return val.replace(escapeRegex, lookupEscape);
    }
    _exports.escape = escape;
    function isFunction(obj) {
      return ObjProto.toString.call(obj) === "[object Function]";
    }
    _exports.isFunction = isFunction;
    function isArray(obj) {
      return ObjProto.toString.call(obj) === "[object Array]";
    }
    _exports.isArray = isArray;
    function isString(obj) {
      return ObjProto.toString.call(obj) === "[object String]";
    }
    _exports.isString = isString;
    function isObject(obj) {
      return ObjProto.toString.call(obj) === "[object Object]";
    }
    _exports.isObject = isObject;
    function _prepareAttributeParts(attr) {
      if (!attr) {
        return [];
      }
      if (typeof attr === "string") {
        return attr.split(".");
      }
      return [attr];
    }
    function getAttrGetter(attribute) {
      var parts = _prepareAttributeParts(attribute);
      return function attrGetter(item) {
        var _item = item;
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i];
          if (hasOwnProp(_item, part)) {
            _item = _item[part];
          } else {
            return void 0;
          }
        }
        return _item;
      };
    }
    _exports.getAttrGetter = getAttrGetter;
    function groupBy(obj, val, throwOnUndefined) {
      var result = {};
      var iterator = isFunction(val) ? val : getAttrGetter(val);
      for (var i = 0; i < obj.length; i++) {
        var value = obj[i];
        var key = iterator(value, i);
        if (key === void 0 && throwOnUndefined === true) {
          throw new TypeError('groupby: attribute "' + val + '" resolved to undefined');
        }
        (result[key] || (result[key] = [])).push(value);
      }
      return result;
    }
    _exports.groupBy = groupBy;
    function toArray(obj) {
      return Array.prototype.slice.call(obj);
    }
    _exports.toArray = toArray;
    function without(array) {
      var result = [];
      if (!array) {
        return result;
      }
      var length = array.length;
      var contains = toArray(arguments).slice(1);
      var index = -1;
      while (++index < length) {
        if (indexOf(contains, array[index]) === -1) {
          result.push(array[index]);
        }
      }
      return result;
    }
    _exports.without = without;
    function repeat(char_, n) {
      var str = "";
      for (var i = 0; i < n; i++) {
        str += char_;
      }
      return str;
    }
    _exports.repeat = repeat;
    function each(obj, func, context) {
      if (obj == null) {
        return;
      }
      if (ArrayProto.forEach && obj.forEach === ArrayProto.forEach) {
        obj.forEach(func, context);
      } else if (obj.length === +obj.length) {
        for (var i = 0, l = obj.length; i < l; i++) {
          func.call(context, obj[i], i, obj);
        }
      }
    }
    _exports.each = each;
    function map(obj, func) {
      var results = [];
      if (obj == null) {
        return results;
      }
      if (ArrayProto.map && obj.map === ArrayProto.map) {
        return obj.map(func);
      }
      for (var i = 0; i < obj.length; i++) {
        results[results.length] = func(obj[i], i);
      }
      if (obj.length === +obj.length) {
        results.length = obj.length;
      }
      return results;
    }
    _exports.map = map;
    function asyncIter(arr, iter, cb) {
      var i = -1;
      function next() {
        i++;
        if (i < arr.length) {
          iter(arr[i], i, next, cb);
        } else {
          cb();
        }
      }
      next();
    }
    _exports.asyncIter = asyncIter;
    function asyncFor(obj, iter, cb) {
      var keys = keys_(obj || {});
      var len = keys.length;
      var i = -1;
      function next() {
        i++;
        var k = keys[i];
        if (i < len) {
          iter(k, obj[k], i, len, next);
        } else {
          cb();
        }
      }
      next();
    }
    _exports.asyncFor = asyncFor;
    function indexOf(arr, searchElement, fromIndex) {
      return Array.prototype.indexOf.call(arr || [], searchElement, fromIndex);
    }
    _exports.indexOf = indexOf;
    function keys_(obj) {
      var arr = [];
      for (var k in obj) {
        if (hasOwnProp(obj, k)) {
          arr.push(k);
        }
      }
      return arr;
    }
    _exports.keys = keys_;
    function _entries(obj) {
      return keys_(obj).map(function(k) {
        return [k, obj[k]];
      });
    }
    _exports._entries = _entries;
    function _values(obj) {
      return keys_(obj).map(function(k) {
        return obj[k];
      });
    }
    _exports._values = _values;
    function extend(obj1, obj2) {
      obj1 = obj1 || {};
      keys_(obj2).forEach(function(k) {
        obj1[k] = obj2[k];
      });
      return obj1;
    }
    _exports._assign = _exports.extend = extend;
    function inOperator(key, val) {
      if (isArray(val) || isString(val)) {
        return val.indexOf(key) !== -1;
      } else if (isObject(val)) {
        return key in val;
      }
      throw new Error('Cannot use "in" operator to search for "' + key + '" in unexpected types.');
    }
    _exports.inOperator = inOperator;
  }
});

// node_modules/asap/raw.js
var require_raw = __commonJS({
  "node_modules/asap/raw.js"(exports, module) {
    "use strict";
    var domain;
    var hasSetImmediate = typeof setImmediate === "function";
    module.exports = rawAsap;
    function rawAsap(task) {
      if (!queue.length) {
        requestFlush();
        flushing = true;
      }
      queue[queue.length] = task;
    }
    var queue = [];
    var flushing = false;
    var index = 0;
    var capacity = 1024;
    function flush() {
      while (index < queue.length) {
        var currentIndex = index;
        index = index + 1;
        queue[currentIndex].call();
        if (index > capacity) {
          for (var scan2 = 0, newLength = queue.length - index; scan2 < newLength; scan2++) {
            queue[scan2] = queue[scan2 + index];
          }
          queue.length -= index;
          index = 0;
        }
      }
      queue.length = 0;
      index = 0;
      flushing = false;
    }
    rawAsap.requestFlush = requestFlush;
    function requestFlush() {
      var parentDomain = process.domain;
      if (parentDomain) {
        if (!domain) {
          domain = __require("domain");
        }
        domain.active = process.domain = null;
      }
      if (flushing && hasSetImmediate) {
        setImmediate(flush);
      } else {
        process.nextTick(flush);
      }
      if (parentDomain) {
        domain.active = process.domain = parentDomain;
      }
    }
  }
});

// node_modules/asap/asap.js
var require_asap = __commonJS({
  "node_modules/asap/asap.js"(exports, module) {
    "use strict";
    var rawAsap = require_raw();
    var freeTasks = [];
    module.exports = asap;
    function asap(task) {
      var rawTask;
      if (freeTasks.length) {
        rawTask = freeTasks.pop();
      } else {
        rawTask = new RawTask();
      }
      rawTask.task = task;
      rawTask.domain = process.domain;
      rawAsap(rawTask);
    }
    function RawTask() {
      this.task = null;
      this.domain = null;
    }
    RawTask.prototype.call = function() {
      if (this.domain) {
        this.domain.enter();
      }
      var threw = true;
      try {
        this.task.call();
        threw = false;
        if (this.domain) {
          this.domain.exit();
        }
      } finally {
        if (threw) {
          rawAsap.requestFlush();
        }
        this.task = null;
        this.domain = null;
        freeTasks.push(this);
      }
    };
  }
});

// node_modules/a-sync-waterfall/index.js
var require_a_sync_waterfall = __commonJS({
  "node_modules/a-sync-waterfall/index.js"(exports, module) {
    (function(globals) {
      "use strict";
      var executeSync = function() {
        var args = Array.prototype.slice.call(arguments);
        if (typeof args[0] === "function") {
          args[0].apply(null, args.splice(1));
        }
      };
      var executeAsync = function(fn) {
        if (typeof setImmediate === "function") {
          setImmediate(fn);
        } else if (typeof process !== "undefined" && process.nextTick) {
          process.nextTick(fn);
        } else {
          setTimeout(fn, 0);
        }
      };
      var makeIterator = function(tasks) {
        var makeCallback = function(index) {
          var fn = function() {
            if (tasks.length) {
              tasks[index].apply(null, arguments);
            }
            return fn.next();
          };
          fn.next = function() {
            return index < tasks.length - 1 ? makeCallback(index + 1) : null;
          };
          return fn;
        };
        return makeCallback(0);
      };
      var _isArray = Array.isArray || function(maybeArray) {
        return Object.prototype.toString.call(maybeArray) === "[object Array]";
      };
      var waterfall = function(tasks, callback, forceAsync) {
        var nextTick = forceAsync ? executeAsync : executeSync;
        callback = callback || function() {
        };
        if (!_isArray(tasks)) {
          var err = new Error("First argument to waterfall must be an array of functions");
          return callback(err);
        }
        if (!tasks.length) {
          return callback();
        }
        var wrapIterator = function(iterator) {
          return function(err2) {
            if (err2) {
              callback.apply(null, arguments);
              callback = function() {
              };
            } else {
              var args = Array.prototype.slice.call(arguments, 1);
              var next = iterator.next();
              if (next) {
                args.push(wrapIterator(next));
              } else {
                args.push(callback);
              }
              nextTick(function() {
                iterator.apply(null, args);
              });
            }
          };
        };
        wrapIterator(makeIterator(tasks))();
      };
      if (typeof define !== "undefined" && define.amd) {
        define([], function() {
          return waterfall;
        });
      } else if (typeof module !== "undefined" && module.exports) {
        module.exports = waterfall;
      } else {
        globals.waterfall = waterfall;
      }
    })(exports);
  }
});

// node_modules/nunjucks/src/lexer.js
var require_lexer = __commonJS({
  "node_modules/nunjucks/src/lexer.js"(exports, module) {
    "use strict";
    var lib = require_lib();
    var whitespaceChars = " \n	\r\xA0";
    var delimChars = "()[]{}%*-+~/#,:|.<>=!";
    var intChars = "0123456789";
    var BLOCK_START = "{%";
    var BLOCK_END = "%}";
    var VARIABLE_START = "{{";
    var VARIABLE_END = "}}";
    var COMMENT_START = "{#";
    var COMMENT_END = "#}";
    var TOKEN_STRING = "string";
    var TOKEN_WHITESPACE = "whitespace";
    var TOKEN_DATA = "data";
    var TOKEN_BLOCK_START = "block-start";
    var TOKEN_BLOCK_END = "block-end";
    var TOKEN_VARIABLE_START = "variable-start";
    var TOKEN_VARIABLE_END = "variable-end";
    var TOKEN_COMMENT = "comment";
    var TOKEN_LEFT_PAREN = "left-paren";
    var TOKEN_RIGHT_PAREN = "right-paren";
    var TOKEN_LEFT_BRACKET = "left-bracket";
    var TOKEN_RIGHT_BRACKET = "right-bracket";
    var TOKEN_LEFT_CURLY = "left-curly";
    var TOKEN_RIGHT_CURLY = "right-curly";
    var TOKEN_OPERATOR = "operator";
    var TOKEN_COMMA = "comma";
    var TOKEN_COLON = "colon";
    var TOKEN_TILDE = "tilde";
    var TOKEN_PIPE = "pipe";
    var TOKEN_INT = "int";
    var TOKEN_FLOAT = "float";
    var TOKEN_BOOLEAN = "boolean";
    var TOKEN_NONE = "none";
    var TOKEN_SYMBOL = "symbol";
    var TOKEN_SPECIAL = "special";
    var TOKEN_REGEX = "regex";
    function token(type, value, lineno, colno) {
      return {
        type,
        value,
        lineno,
        colno
      };
    }
    var Tokenizer = /* @__PURE__ */ (function() {
      function Tokenizer2(str, opts) {
        this.str = str;
        this.index = 0;
        this.len = str.length;
        this.lineno = 0;
        this.colno = 0;
        this.in_code = false;
        opts = opts || {};
        var tags = opts.tags || {};
        this.tags = {
          BLOCK_START: tags.blockStart || BLOCK_START,
          BLOCK_END: tags.blockEnd || BLOCK_END,
          VARIABLE_START: tags.variableStart || VARIABLE_START,
          VARIABLE_END: tags.variableEnd || VARIABLE_END,
          COMMENT_START: tags.commentStart || COMMENT_START,
          COMMENT_END: tags.commentEnd || COMMENT_END
        };
        this.trimBlocks = !!opts.trimBlocks;
        this.lstripBlocks = !!opts.lstripBlocks;
      }
      var _proto = Tokenizer2.prototype;
      _proto.nextToken = function nextToken() {
        var lineno = this.lineno;
        var colno = this.colno;
        var tok;
        if (this.in_code) {
          var cur = this.current();
          if (this.isFinished()) {
            return null;
          } else if (cur === '"' || cur === "'") {
            return token(TOKEN_STRING, this._parseString(cur), lineno, colno);
          } else if (tok = this._extract(whitespaceChars)) {
            return token(TOKEN_WHITESPACE, tok, lineno, colno);
          } else if ((tok = this._extractString(this.tags.BLOCK_END)) || (tok = this._extractString("-" + this.tags.BLOCK_END))) {
            this.in_code = false;
            if (this.trimBlocks) {
              cur = this.current();
              if (cur === "\n") {
                this.forward();
              } else if (cur === "\r") {
                this.forward();
                cur = this.current();
                if (cur === "\n") {
                  this.forward();
                } else {
                  this.back();
                }
              }
            }
            return token(TOKEN_BLOCK_END, tok, lineno, colno);
          } else if ((tok = this._extractString(this.tags.VARIABLE_END)) || (tok = this._extractString("-" + this.tags.VARIABLE_END))) {
            this.in_code = false;
            return token(TOKEN_VARIABLE_END, tok, lineno, colno);
          } else if (cur === "r" && this.str.charAt(this.index + 1) === "/") {
            this.forwardN(2);
            var regexBody = "";
            while (!this.isFinished()) {
              if (this.current() === "/" && this.previous() !== "\\") {
                this.forward();
                break;
              } else {
                regexBody += this.current();
                this.forward();
              }
            }
            var POSSIBLE_FLAGS = ["g", "i", "m", "y"];
            var regexFlags = "";
            while (!this.isFinished()) {
              var isCurrentAFlag = POSSIBLE_FLAGS.indexOf(this.current()) !== -1;
              if (isCurrentAFlag) {
                regexFlags += this.current();
                this.forward();
              } else {
                break;
              }
            }
            return token(TOKEN_REGEX, {
              body: regexBody,
              flags: regexFlags
            }, lineno, colno);
          } else if (delimChars.indexOf(cur) !== -1) {
            this.forward();
            var complexOps = ["==", "===", "!=", "!==", "<=", ">=", "//", "**"];
            var curComplex = cur + this.current();
            var type;
            if (lib.indexOf(complexOps, curComplex) !== -1) {
              this.forward();
              cur = curComplex;
              if (lib.indexOf(complexOps, curComplex + this.current()) !== -1) {
                cur = curComplex + this.current();
                this.forward();
              }
            }
            switch (cur) {
              case "(":
                type = TOKEN_LEFT_PAREN;
                break;
              case ")":
                type = TOKEN_RIGHT_PAREN;
                break;
              case "[":
                type = TOKEN_LEFT_BRACKET;
                break;
              case "]":
                type = TOKEN_RIGHT_BRACKET;
                break;
              case "{":
                type = TOKEN_LEFT_CURLY;
                break;
              case "}":
                type = TOKEN_RIGHT_CURLY;
                break;
              case ",":
                type = TOKEN_COMMA;
                break;
              case ":":
                type = TOKEN_COLON;
                break;
              case "~":
                type = TOKEN_TILDE;
                break;
              case "|":
                type = TOKEN_PIPE;
                break;
              default:
                type = TOKEN_OPERATOR;
            }
            return token(type, cur, lineno, colno);
          } else {
            tok = this._extractUntil(whitespaceChars + delimChars);
            if (tok.match(/^[-+]?[0-9]+$/)) {
              if (this.current() === ".") {
                this.forward();
                var dec = this._extract(intChars);
                return token(TOKEN_FLOAT, tok + "." + dec, lineno, colno);
              } else {
                return token(TOKEN_INT, tok, lineno, colno);
              }
            } else if (tok.match(/^(true|false)$/)) {
              return token(TOKEN_BOOLEAN, tok, lineno, colno);
            } else if (tok === "none") {
              return token(TOKEN_NONE, tok, lineno, colno);
            } else if (tok === "null") {
              return token(TOKEN_NONE, tok, lineno, colno);
            } else if (tok) {
              return token(TOKEN_SYMBOL, tok, lineno, colno);
            } else {
              throw new Error("Unexpected value while parsing: " + tok);
            }
          }
        } else {
          var beginChars = this.tags.BLOCK_START.charAt(0) + this.tags.VARIABLE_START.charAt(0) + this.tags.COMMENT_START.charAt(0) + this.tags.COMMENT_END.charAt(0);
          if (this.isFinished()) {
            return null;
          } else if ((tok = this._extractString(this.tags.BLOCK_START + "-")) || (tok = this._extractString(this.tags.BLOCK_START))) {
            this.in_code = true;
            return token(TOKEN_BLOCK_START, tok, lineno, colno);
          } else if ((tok = this._extractString(this.tags.VARIABLE_START + "-")) || (tok = this._extractString(this.tags.VARIABLE_START))) {
            this.in_code = true;
            return token(TOKEN_VARIABLE_START, tok, lineno, colno);
          } else {
            tok = "";
            var data;
            var inComment = false;
            if (this._matches(this.tags.COMMENT_START)) {
              inComment = true;
              tok = this._extractString(this.tags.COMMENT_START);
            }
            while ((data = this._extractUntil(beginChars)) !== null) {
              tok += data;
              if ((this._matches(this.tags.BLOCK_START) || this._matches(this.tags.VARIABLE_START) || this._matches(this.tags.COMMENT_START)) && !inComment) {
                if (this.lstripBlocks && this._matches(this.tags.BLOCK_START) && this.colno > 0 && this.colno <= tok.length) {
                  var lastLine = tok.slice(-this.colno);
                  if (/^\s+$/.test(lastLine)) {
                    tok = tok.slice(0, -this.colno);
                    if (!tok.length) {
                      return this.nextToken();
                    }
                  }
                }
                break;
              } else if (this._matches(this.tags.COMMENT_END)) {
                if (!inComment) {
                  throw new Error("unexpected end of comment");
                }
                tok += this._extractString(this.tags.COMMENT_END);
                break;
              } else {
                tok += this.current();
                this.forward();
              }
            }
            if (data === null && inComment) {
              throw new Error("expected end of comment, got end of file");
            }
            return token(inComment ? TOKEN_COMMENT : TOKEN_DATA, tok, lineno, colno);
          }
        }
      };
      _proto._parseString = function _parseString(delimiter) {
        this.forward();
        var str = "";
        while (!this.isFinished() && this.current() !== delimiter) {
          var cur = this.current();
          if (cur === "\\") {
            this.forward();
            switch (this.current()) {
              case "n":
                str += "\n";
                break;
              case "t":
                str += "	";
                break;
              case "r":
                str += "\r";
                break;
              default:
                str += this.current();
            }
            this.forward();
          } else {
            str += cur;
            this.forward();
          }
        }
        this.forward();
        return str;
      };
      _proto._matches = function _matches(str) {
        if (this.index + str.length > this.len) {
          return null;
        }
        var m = this.str.slice(this.index, this.index + str.length);
        return m === str;
      };
      _proto._extractString = function _extractString(str) {
        if (this._matches(str)) {
          this.forwardN(str.length);
          return str;
        }
        return null;
      };
      _proto._extractUntil = function _extractUntil(charString) {
        return this._extractMatching(true, charString || "");
      };
      _proto._extract = function _extract(charString) {
        return this._extractMatching(false, charString);
      };
      _proto._extractMatching = function _extractMatching(breakOnMatch, charString) {
        if (this.isFinished()) {
          return null;
        }
        var first = charString.indexOf(this.current());
        if (breakOnMatch && first === -1 || !breakOnMatch && first !== -1) {
          var t = this.current();
          this.forward();
          var idx = charString.indexOf(this.current());
          while ((breakOnMatch && idx === -1 || !breakOnMatch && idx !== -1) && !this.isFinished()) {
            t += this.current();
            this.forward();
            idx = charString.indexOf(this.current());
          }
          return t;
        }
        return "";
      };
      _proto._extractRegex = function _extractRegex(regex) {
        var matches = this.currentStr().match(regex);
        if (!matches) {
          return null;
        }
        this.forwardN(matches[0].length);
        return matches;
      };
      _proto.isFinished = function isFinished() {
        return this.index >= this.len;
      };
      _proto.forwardN = function forwardN(n) {
        for (var i = 0; i < n; i++) {
          this.forward();
        }
      };
      _proto.forward = function forward() {
        this.index++;
        if (this.previous() === "\n") {
          this.lineno++;
          this.colno = 0;
        } else {
          this.colno++;
        }
      };
      _proto.backN = function backN(n) {
        for (var i = 0; i < n; i++) {
          this.back();
        }
      };
      _proto.back = function back() {
        this.index--;
        if (this.current() === "\n") {
          this.lineno--;
          var idx = this.src.lastIndexOf("\n", this.index - 1);
          if (idx === -1) {
            this.colno = this.index;
          } else {
            this.colno = this.index - idx;
          }
        } else {
          this.colno--;
        }
      };
      _proto.current = function current() {
        if (!this.isFinished()) {
          return this.str.charAt(this.index);
        }
        return "";
      };
      _proto.currentStr = function currentStr() {
        if (!this.isFinished()) {
          return this.str.substr(this.index);
        }
        return "";
      };
      _proto.previous = function previous() {
        return this.str.charAt(this.index - 1);
      };
      return Tokenizer2;
    })();
    module.exports = {
      lex: function lex(src, opts) {
        return new Tokenizer(src, opts);
      },
      TOKEN_STRING,
      TOKEN_WHITESPACE,
      TOKEN_DATA,
      TOKEN_BLOCK_START,
      TOKEN_BLOCK_END,
      TOKEN_VARIABLE_START,
      TOKEN_VARIABLE_END,
      TOKEN_COMMENT,
      TOKEN_LEFT_PAREN,
      TOKEN_RIGHT_PAREN,
      TOKEN_LEFT_BRACKET,
      TOKEN_RIGHT_BRACKET,
      TOKEN_LEFT_CURLY,
      TOKEN_RIGHT_CURLY,
      TOKEN_OPERATOR,
      TOKEN_COMMA,
      TOKEN_COLON,
      TOKEN_TILDE,
      TOKEN_PIPE,
      TOKEN_INT,
      TOKEN_FLOAT,
      TOKEN_BOOLEAN,
      TOKEN_NONE,
      TOKEN_SYMBOL,
      TOKEN_SPECIAL,
      TOKEN_REGEX
    };
  }
});

// node_modules/nunjucks/src/object.js
var require_object = __commonJS({
  "node_modules/nunjucks/src/object.js"(exports, module) {
    "use strict";
    function _defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor) descriptor.writable = true;
        Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
      }
    }
    function _createClass(Constructor, protoProps, staticProps) {
      if (protoProps) _defineProperties(Constructor.prototype, protoProps);
      if (staticProps) _defineProperties(Constructor, staticProps);
      Object.defineProperty(Constructor, "prototype", { writable: false });
      return Constructor;
    }
    function _toPropertyKey(arg) {
      var key = _toPrimitive(arg, "string");
      return typeof key === "symbol" ? key : String(key);
    }
    function _toPrimitive(input, hint) {
      if (typeof input !== "object" || input === null) return input;
      var prim = input[Symbol.toPrimitive];
      if (prim !== void 0) {
        var res = prim.call(input, hint || "default");
        if (typeof res !== "object") return res;
        throw new TypeError("@@toPrimitive must return a primitive value.");
      }
      return (hint === "string" ? String : Number)(input);
    }
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var EventEmitter = __require("events");
    var lib = require_lib();
    function parentWrap(parent, prop) {
      if (typeof parent !== "function" || typeof prop !== "function") {
        return prop;
      }
      return function wrap() {
        var tmp = this.parent;
        this.parent = parent;
        var res = prop.apply(this, arguments);
        this.parent = tmp;
        return res;
      };
    }
    function extendClass(cls, name, props) {
      props = props || {};
      lib.keys(props).forEach(function(k) {
        props[k] = parentWrap(cls.prototype[k], props[k]);
      });
      var subclass = /* @__PURE__ */ (function(_cls) {
        _inheritsLoose(subclass2, _cls);
        function subclass2() {
          return _cls.apply(this, arguments) || this;
        }
        _createClass(subclass2, [{
          key: "typename",
          get: function get() {
            return name;
          }
        }]);
        return subclass2;
      })(cls);
      lib._assign(subclass.prototype, props);
      return subclass;
    }
    var Obj = /* @__PURE__ */ (function() {
      function Obj2() {
        this.init.apply(this, arguments);
      }
      var _proto = Obj2.prototype;
      _proto.init = function init() {
      };
      Obj2.extend = function extend(name, props) {
        if (typeof name === "object") {
          props = name;
          name = "anonymous";
        }
        return extendClass(this, name, props);
      };
      _createClass(Obj2, [{
        key: "typename",
        get: function get() {
          return this.constructor.name;
        }
      }]);
      return Obj2;
    })();
    var EmitterObj = /* @__PURE__ */ (function(_EventEmitter) {
      _inheritsLoose(EmitterObj2, _EventEmitter);
      function EmitterObj2() {
        var _this2;
        var _this;
        _this = _EventEmitter.call(this) || this;
        (_this2 = _this).init.apply(_this2, arguments);
        return _this;
      }
      var _proto2 = EmitterObj2.prototype;
      _proto2.init = function init() {
      };
      EmitterObj2.extend = function extend(name, props) {
        if (typeof name === "object") {
          props = name;
          name = "anonymous";
        }
        return extendClass(this, name, props);
      };
      _createClass(EmitterObj2, [{
        key: "typename",
        get: function get() {
          return this.constructor.name;
        }
      }]);
      return EmitterObj2;
    })(EventEmitter);
    module.exports = {
      Obj,
      EmitterObj
    };
  }
});

// node_modules/nunjucks/src/nodes.js
var require_nodes = __commonJS({
  "node_modules/nunjucks/src/nodes.js"(exports, module) {
    "use strict";
    function _defineProperties(target, props) {
      for (var i = 0; i < props.length; i++) {
        var descriptor = props[i];
        descriptor.enumerable = descriptor.enumerable || false;
        descriptor.configurable = true;
        if ("value" in descriptor) descriptor.writable = true;
        Object.defineProperty(target, _toPropertyKey(descriptor.key), descriptor);
      }
    }
    function _createClass(Constructor, protoProps, staticProps) {
      if (protoProps) _defineProperties(Constructor.prototype, protoProps);
      if (staticProps) _defineProperties(Constructor, staticProps);
      Object.defineProperty(Constructor, "prototype", { writable: false });
      return Constructor;
    }
    function _toPropertyKey(arg) {
      var key = _toPrimitive(arg, "string");
      return typeof key === "symbol" ? key : String(key);
    }
    function _toPrimitive(input, hint) {
      if (typeof input !== "object" || input === null) return input;
      var prim = input[Symbol.toPrimitive];
      if (prim !== void 0) {
        var res = prim.call(input, hint || "default");
        if (typeof res !== "object") return res;
        throw new TypeError("@@toPrimitive must return a primitive value.");
      }
      return (hint === "string" ? String : Number)(input);
    }
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var _require = require_object();
    var Obj = _require.Obj;
    function traverseAndCheck(obj, type, results) {
      if (obj instanceof type) {
        results.push(obj);
      }
      if (obj instanceof Node) {
        obj.findAll(type, results);
      }
    }
    var Node = /* @__PURE__ */ (function(_Obj) {
      _inheritsLoose(Node2, _Obj);
      function Node2() {
        return _Obj.apply(this, arguments) || this;
      }
      var _proto = Node2.prototype;
      _proto.init = function init(lineno, colno) {
        var _arguments = arguments, _this = this;
        for (var _len = arguments.length, args = new Array(_len > 2 ? _len - 2 : 0), _key = 2; _key < _len; _key++) {
          args[_key - 2] = arguments[_key];
        }
        this.lineno = lineno;
        this.colno = colno;
        this.fields.forEach(function(field, i) {
          var val = _arguments[i + 2];
          if (val === void 0) {
            val = null;
          }
          _this[field] = val;
        });
      };
      _proto.findAll = function findAll(type, results) {
        var _this2 = this;
        results = results || [];
        if (this instanceof NodeList) {
          this.children.forEach(function(child) {
            return traverseAndCheck(child, type, results);
          });
        } else {
          this.fields.forEach(function(field) {
            return traverseAndCheck(_this2[field], type, results);
          });
        }
        return results;
      };
      _proto.iterFields = function iterFields(func) {
        var _this3 = this;
        this.fields.forEach(function(field) {
          func(_this3[field], field);
        });
      };
      return Node2;
    })(Obj);
    var Value = /* @__PURE__ */ (function(_Node) {
      _inheritsLoose(Value2, _Node);
      function Value2() {
        return _Node.apply(this, arguments) || this;
      }
      _createClass(Value2, [{
        key: "typename",
        get: function get() {
          return "Value";
        }
      }, {
        key: "fields",
        get: function get() {
          return ["value"];
        }
      }]);
      return Value2;
    })(Node);
    var NodeList = /* @__PURE__ */ (function(_Node2) {
      _inheritsLoose(NodeList2, _Node2);
      function NodeList2() {
        return _Node2.apply(this, arguments) || this;
      }
      var _proto2 = NodeList2.prototype;
      _proto2.init = function init(lineno, colno, nodes) {
        _Node2.prototype.init.call(this, lineno, colno, nodes || []);
      };
      _proto2.addChild = function addChild(node) {
        this.children.push(node);
      };
      _createClass(NodeList2, [{
        key: "typename",
        get: function get() {
          return "NodeList";
        }
      }, {
        key: "fields",
        get: function get() {
          return ["children"];
        }
      }]);
      return NodeList2;
    })(Node);
    var Root = NodeList.extend("Root");
    var Literal = Value.extend("Literal");
    var _Symbol = Value.extend("Symbol");
    var Group = NodeList.extend("Group");
    var ArrayNode = NodeList.extend("Array");
    var Pair = Node.extend("Pair", {
      fields: ["key", "value"]
    });
    var Dict = NodeList.extend("Dict");
    var LookupVal = Node.extend("LookupVal", {
      fields: ["target", "val"]
    });
    var If = Node.extend("If", {
      fields: ["cond", "body", "else_"]
    });
    var IfAsync = If.extend("IfAsync");
    var InlineIf = Node.extend("InlineIf", {
      fields: ["cond", "body", "else_"]
    });
    var For = Node.extend("For", {
      fields: ["arr", "name", "body", "else_"]
    });
    var AsyncEach = For.extend("AsyncEach");
    var AsyncAll = For.extend("AsyncAll");
    var Macro = Node.extend("Macro", {
      fields: ["name", "args", "body"]
    });
    var Caller = Macro.extend("Caller");
    var Import = Node.extend("Import", {
      fields: ["template", "target", "withContext"]
    });
    var FromImport = /* @__PURE__ */ (function(_Node3) {
      _inheritsLoose(FromImport2, _Node3);
      function FromImport2() {
        return _Node3.apply(this, arguments) || this;
      }
      var _proto3 = FromImport2.prototype;
      _proto3.init = function init(lineno, colno, template, names, withContext) {
        _Node3.prototype.init.call(this, lineno, colno, template, names || new NodeList(), withContext);
      };
      _createClass(FromImport2, [{
        key: "typename",
        get: function get() {
          return "FromImport";
        }
      }, {
        key: "fields",
        get: function get() {
          return ["template", "names", "withContext"];
        }
      }]);
      return FromImport2;
    })(Node);
    var FunCall = Node.extend("FunCall", {
      fields: ["name", "args"]
    });
    var Filter = FunCall.extend("Filter");
    var FilterAsync = Filter.extend("FilterAsync", {
      fields: ["name", "args", "symbol"]
    });
    var KeywordArgs = Dict.extend("KeywordArgs");
    var Block = Node.extend("Block", {
      fields: ["name", "body"]
    });
    var Super = Node.extend("Super", {
      fields: ["blockName", "symbol"]
    });
    var TemplateRef = Node.extend("TemplateRef", {
      fields: ["template"]
    });
    var Extends = TemplateRef.extend("Extends");
    var Include = Node.extend("Include", {
      fields: ["template", "ignoreMissing"]
    });
    var Set2 = Node.extend("Set", {
      fields: ["targets", "value"]
    });
    var Switch = Node.extend("Switch", {
      fields: ["expr", "cases", "default"]
    });
    var Case = Node.extend("Case", {
      fields: ["cond", "body"]
    });
    var Output = NodeList.extend("Output");
    var Capture = Node.extend("Capture", {
      fields: ["body"]
    });
    var TemplateData = Literal.extend("TemplateData");
    var UnaryOp = Node.extend("UnaryOp", {
      fields: ["target"]
    });
    var BinOp = Node.extend("BinOp", {
      fields: ["left", "right"]
    });
    var In = BinOp.extend("In");
    var Is = BinOp.extend("Is");
    var Or = BinOp.extend("Or");
    var And = BinOp.extend("And");
    var Not = UnaryOp.extend("Not");
    var Add = BinOp.extend("Add");
    var Concat = BinOp.extend("Concat");
    var Sub = BinOp.extend("Sub");
    var Mul = BinOp.extend("Mul");
    var Div = BinOp.extend("Div");
    var FloorDiv = BinOp.extend("FloorDiv");
    var Mod = BinOp.extend("Mod");
    var Pow = BinOp.extend("Pow");
    var Neg = UnaryOp.extend("Neg");
    var Pos = UnaryOp.extend("Pos");
    var Compare = Node.extend("Compare", {
      fields: ["expr", "ops"]
    });
    var CompareOperand = Node.extend("CompareOperand", {
      fields: ["expr", "type"]
    });
    var CallExtension = Node.extend("CallExtension", {
      init: function init(ext, prop, args, contentArgs) {
        this.parent();
        this.extName = ext.__name || ext;
        this.prop = prop;
        this.args = args || new NodeList();
        this.contentArgs = contentArgs || [];
        this.autoescape = ext.autoescape;
      },
      fields: ["extName", "prop", "args", "contentArgs"]
    });
    var CallExtensionAsync = CallExtension.extend("CallExtensionAsync");
    function print(str, indent, inline) {
      var lines = str.split("\n");
      lines.forEach(function(line, i) {
        if (line && (inline && i > 0 || !inline)) {
          process.stdout.write(" ".repeat(indent));
        }
        var nl = i === lines.length - 1 ? "" : "\n";
        process.stdout.write("" + line + nl);
      });
    }
    function printNodes(node, indent) {
      indent = indent || 0;
      print(node.typename + ": ", indent);
      if (node instanceof NodeList) {
        print("\n");
        node.children.forEach(function(n) {
          printNodes(n, indent + 2);
        });
      } else if (node instanceof CallExtension) {
        print(node.extName + "." + node.prop + "\n");
        if (node.args) {
          printNodes(node.args, indent + 2);
        }
        if (node.contentArgs) {
          node.contentArgs.forEach(function(n) {
            printNodes(n, indent + 2);
          });
        }
      } else {
        var nodes = [];
        var props = null;
        node.iterFields(function(val, fieldName) {
          if (val instanceof Node) {
            nodes.push([fieldName, val]);
          } else {
            props = props || {};
            props[fieldName] = val;
          }
        });
        if (props) {
          print(JSON.stringify(props, null, 2) + "\n", null, true);
        } else {
          print("\n");
        }
        nodes.forEach(function(_ref) {
          var fieldName = _ref[0], n = _ref[1];
          print("[" + fieldName + "] =>", indent + 2);
          printNodes(n, indent + 4);
        });
      }
    }
    module.exports = {
      Node,
      Root,
      NodeList,
      Value,
      Literal,
      Symbol: _Symbol,
      Group,
      Array: ArrayNode,
      Pair,
      Dict,
      Output,
      Capture,
      TemplateData,
      If,
      IfAsync,
      InlineIf,
      For,
      AsyncEach,
      AsyncAll,
      Macro,
      Caller,
      Import,
      FromImport,
      FunCall,
      Filter,
      FilterAsync,
      KeywordArgs,
      Block,
      Super,
      Extends,
      Include,
      Set: Set2,
      Switch,
      Case,
      LookupVal,
      BinOp,
      In,
      Is,
      Or,
      And,
      Not,
      Add,
      Concat,
      Sub,
      Mul,
      Div,
      FloorDiv,
      Mod,
      Pow,
      Neg,
      Pos,
      Compare,
      CompareOperand,
      CallExtension,
      CallExtensionAsync,
      printNodes
    };
  }
});

// node_modules/nunjucks/src/parser.js
var require_parser = __commonJS({
  "node_modules/nunjucks/src/parser.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var lexer = require_lexer();
    var nodes = require_nodes();
    var Obj = require_object().Obj;
    var lib = require_lib();
    var Parser = /* @__PURE__ */ (function(_Obj) {
      _inheritsLoose(Parser2, _Obj);
      function Parser2() {
        return _Obj.apply(this, arguments) || this;
      }
      var _proto = Parser2.prototype;
      _proto.init = function init(tokens) {
        this.tokens = tokens;
        this.peeked = null;
        this.breakOnBlocks = null;
        this.dropLeadingWhitespace = false;
        this.extensions = [];
      };
      _proto.nextToken = function nextToken(withWhitespace) {
        var tok;
        if (this.peeked) {
          if (!withWhitespace && this.peeked.type === lexer.TOKEN_WHITESPACE) {
            this.peeked = null;
          } else {
            tok = this.peeked;
            this.peeked = null;
            return tok;
          }
        }
        tok = this.tokens.nextToken();
        if (!withWhitespace) {
          while (tok && tok.type === lexer.TOKEN_WHITESPACE) {
            tok = this.tokens.nextToken();
          }
        }
        return tok;
      };
      _proto.peekToken = function peekToken() {
        this.peeked = this.peeked || this.nextToken();
        return this.peeked;
      };
      _proto.pushToken = function pushToken(tok) {
        if (this.peeked) {
          throw new Error("pushToken: can only push one token on between reads");
        }
        this.peeked = tok;
      };
      _proto.error = function error(msg, lineno, colno) {
        if (lineno === void 0 || colno === void 0) {
          var tok = this.peekToken() || {};
          lineno = tok.lineno;
          colno = tok.colno;
        }
        if (lineno !== void 0) {
          lineno += 1;
        }
        if (colno !== void 0) {
          colno += 1;
        }
        return new lib.TemplateError(msg, lineno, colno);
      };
      _proto.fail = function fail(msg, lineno, colno) {
        throw this.error(msg, lineno, colno);
      };
      _proto.skip = function skip(type) {
        var tok = this.nextToken();
        if (!tok || tok.type !== type) {
          this.pushToken(tok);
          return false;
        }
        return true;
      };
      _proto.expect = function expect(type) {
        var tok = this.nextToken();
        if (tok.type !== type) {
          this.fail("expected " + type + ", got " + tok.type, tok.lineno, tok.colno);
        }
        return tok;
      };
      _proto.skipValue = function skipValue(type, val) {
        var tok = this.nextToken();
        if (!tok || tok.type !== type || tok.value !== val) {
          this.pushToken(tok);
          return false;
        }
        return true;
      };
      _proto.skipSymbol = function skipSymbol(val) {
        return this.skipValue(lexer.TOKEN_SYMBOL, val);
      };
      _proto.advanceAfterBlockEnd = function advanceAfterBlockEnd(name) {
        var tok;
        if (!name) {
          tok = this.peekToken();
          if (!tok) {
            this.fail("unexpected end of file");
          }
          if (tok.type !== lexer.TOKEN_SYMBOL) {
            this.fail("advanceAfterBlockEnd: expected symbol token or explicit name to be passed");
          }
          name = this.nextToken().value;
        }
        tok = this.nextToken();
        if (tok && tok.type === lexer.TOKEN_BLOCK_END) {
          if (tok.value.charAt(0) === "-") {
            this.dropLeadingWhitespace = true;
          }
        } else {
          this.fail("expected block end in " + name + " statement");
        }
        return tok;
      };
      _proto.advanceAfterVariableEnd = function advanceAfterVariableEnd() {
        var tok = this.nextToken();
        if (tok && tok.type === lexer.TOKEN_VARIABLE_END) {
          this.dropLeadingWhitespace = tok.value.charAt(tok.value.length - this.tokens.tags.VARIABLE_END.length - 1) === "-";
        } else {
          this.pushToken(tok);
          this.fail("expected variable end");
        }
      };
      _proto.parseFor = function parseFor() {
        var forTok = this.peekToken();
        var node;
        var endBlock;
        if (this.skipSymbol("for")) {
          node = new nodes.For(forTok.lineno, forTok.colno);
          endBlock = "endfor";
        } else if (this.skipSymbol("asyncEach")) {
          node = new nodes.AsyncEach(forTok.lineno, forTok.colno);
          endBlock = "endeach";
        } else if (this.skipSymbol("asyncAll")) {
          node = new nodes.AsyncAll(forTok.lineno, forTok.colno);
          endBlock = "endall";
        } else {
          this.fail("parseFor: expected for{Async}", forTok.lineno, forTok.colno);
        }
        node.name = this.parsePrimary();
        if (!(node.name instanceof nodes.Symbol)) {
          this.fail("parseFor: variable name expected for loop");
        }
        var type = this.peekToken().type;
        if (type === lexer.TOKEN_COMMA) {
          var key = node.name;
          node.name = new nodes.Array(key.lineno, key.colno);
          node.name.addChild(key);
          while (this.skip(lexer.TOKEN_COMMA)) {
            var prim = this.parsePrimary();
            node.name.addChild(prim);
          }
        }
        if (!this.skipSymbol("in")) {
          this.fail('parseFor: expected "in" keyword for loop', forTok.lineno, forTok.colno);
        }
        node.arr = this.parseExpression();
        this.advanceAfterBlockEnd(forTok.value);
        node.body = this.parseUntilBlocks(endBlock, "else");
        if (this.skipSymbol("else")) {
          this.advanceAfterBlockEnd("else");
          node.else_ = this.parseUntilBlocks(endBlock);
        }
        this.advanceAfterBlockEnd();
        return node;
      };
      _proto.parseMacro = function parseMacro() {
        var macroTok = this.peekToken();
        if (!this.skipSymbol("macro")) {
          this.fail("expected macro");
        }
        var name = this.parsePrimary(true);
        var args = this.parseSignature();
        var node = new nodes.Macro(macroTok.lineno, macroTok.colno, name, args);
        this.advanceAfterBlockEnd(macroTok.value);
        node.body = this.parseUntilBlocks("endmacro");
        this.advanceAfterBlockEnd();
        return node;
      };
      _proto.parseCall = function parseCall() {
        var callTok = this.peekToken();
        if (!this.skipSymbol("call")) {
          this.fail("expected call");
        }
        var callerArgs = this.parseSignature(true) || new nodes.NodeList();
        var macroCall = this.parsePrimary();
        this.advanceAfterBlockEnd(callTok.value);
        var body = this.parseUntilBlocks("endcall");
        this.advanceAfterBlockEnd();
        var callerName = new nodes.Symbol(callTok.lineno, callTok.colno, "caller");
        var callerNode = new nodes.Caller(callTok.lineno, callTok.colno, callerName, callerArgs, body);
        var args = macroCall.args.children;
        if (!(args[args.length - 1] instanceof nodes.KeywordArgs)) {
          args.push(new nodes.KeywordArgs());
        }
        var kwargs = args[args.length - 1];
        kwargs.addChild(new nodes.Pair(callTok.lineno, callTok.colno, callerName, callerNode));
        return new nodes.Output(callTok.lineno, callTok.colno, [macroCall]);
      };
      _proto.parseWithContext = function parseWithContext() {
        var tok = this.peekToken();
        var withContext = null;
        if (this.skipSymbol("with")) {
          withContext = true;
        } else if (this.skipSymbol("without")) {
          withContext = false;
        }
        if (withContext !== null) {
          if (!this.skipSymbol("context")) {
            this.fail("parseFrom: expected context after with/without", tok.lineno, tok.colno);
          }
        }
        return withContext;
      };
      _proto.parseImport = function parseImport() {
        var importTok = this.peekToken();
        if (!this.skipSymbol("import")) {
          this.fail("parseImport: expected import", importTok.lineno, importTok.colno);
        }
        var template = this.parseExpression();
        if (!this.skipSymbol("as")) {
          this.fail('parseImport: expected "as" keyword', importTok.lineno, importTok.colno);
        }
        var target = this.parseExpression();
        var withContext = this.parseWithContext();
        var node = new nodes.Import(importTok.lineno, importTok.colno, template, target, withContext);
        this.advanceAfterBlockEnd(importTok.value);
        return node;
      };
      _proto.parseFrom = function parseFrom() {
        var fromTok = this.peekToken();
        if (!this.skipSymbol("from")) {
          this.fail("parseFrom: expected from");
        }
        var template = this.parseExpression();
        if (!this.skipSymbol("import")) {
          this.fail("parseFrom: expected import", fromTok.lineno, fromTok.colno);
        }
        var names = new nodes.NodeList();
        var withContext;
        while (1) {
          var nextTok = this.peekToken();
          if (nextTok.type === lexer.TOKEN_BLOCK_END) {
            if (!names.children.length) {
              this.fail("parseFrom: Expected at least one import name", fromTok.lineno, fromTok.colno);
            }
            if (nextTok.value.charAt(0) === "-") {
              this.dropLeadingWhitespace = true;
            }
            this.nextToken();
            break;
          }
          if (names.children.length > 0 && !this.skip(lexer.TOKEN_COMMA)) {
            this.fail("parseFrom: expected comma", fromTok.lineno, fromTok.colno);
          }
          var name = this.parsePrimary();
          if (name.value.charAt(0) === "_") {
            this.fail("parseFrom: names starting with an underscore cannot be imported", name.lineno, name.colno);
          }
          if (this.skipSymbol("as")) {
            var alias = this.parsePrimary();
            names.addChild(new nodes.Pair(name.lineno, name.colno, name, alias));
          } else {
            names.addChild(name);
          }
          withContext = this.parseWithContext();
        }
        return new nodes.FromImport(fromTok.lineno, fromTok.colno, template, names, withContext);
      };
      _proto.parseBlock = function parseBlock() {
        var tag = this.peekToken();
        if (!this.skipSymbol("block")) {
          this.fail("parseBlock: expected block", tag.lineno, tag.colno);
        }
        var node = new nodes.Block(tag.lineno, tag.colno);
        node.name = this.parsePrimary();
        if (!(node.name instanceof nodes.Symbol)) {
          this.fail("parseBlock: variable name expected", tag.lineno, tag.colno);
        }
        this.advanceAfterBlockEnd(tag.value);
        node.body = this.parseUntilBlocks("endblock");
        this.skipSymbol("endblock");
        this.skipSymbol(node.name.value);
        var tok = this.peekToken();
        if (!tok) {
          this.fail("parseBlock: expected endblock, got end of file");
        }
        this.advanceAfterBlockEnd(tok.value);
        return node;
      };
      _proto.parseExtends = function parseExtends() {
        var tagName = "extends";
        var tag = this.peekToken();
        if (!this.skipSymbol(tagName)) {
          this.fail("parseTemplateRef: expected " + tagName);
        }
        var node = new nodes.Extends(tag.lineno, tag.colno);
        node.template = this.parseExpression();
        this.advanceAfterBlockEnd(tag.value);
        return node;
      };
      _proto.parseInclude = function parseInclude() {
        var tagName = "include";
        var tag = this.peekToken();
        if (!this.skipSymbol(tagName)) {
          this.fail("parseInclude: expected " + tagName);
        }
        var node = new nodes.Include(tag.lineno, tag.colno);
        node.template = this.parseExpression();
        if (this.skipSymbol("ignore") && this.skipSymbol("missing")) {
          node.ignoreMissing = true;
        }
        this.advanceAfterBlockEnd(tag.value);
        return node;
      };
      _proto.parseIf = function parseIf() {
        var tag = this.peekToken();
        var node;
        if (this.skipSymbol("if") || this.skipSymbol("elif") || this.skipSymbol("elseif")) {
          node = new nodes.If(tag.lineno, tag.colno);
        } else if (this.skipSymbol("ifAsync")) {
          node = new nodes.IfAsync(tag.lineno, tag.colno);
        } else {
          this.fail("parseIf: expected if, elif, or elseif", tag.lineno, tag.colno);
        }
        node.cond = this.parseExpression();
        this.advanceAfterBlockEnd(tag.value);
        node.body = this.parseUntilBlocks("elif", "elseif", "else", "endif");
        var tok = this.peekToken();
        switch (tok && tok.value) {
          case "elseif":
          case "elif":
            node.else_ = this.parseIf();
            break;
          case "else":
            this.advanceAfterBlockEnd();
            node.else_ = this.parseUntilBlocks("endif");
            this.advanceAfterBlockEnd();
            break;
          case "endif":
            node.else_ = null;
            this.advanceAfterBlockEnd();
            break;
          default:
            this.fail("parseIf: expected elif, else, or endif, got end of file");
        }
        return node;
      };
      _proto.parseSet = function parseSet() {
        var tag = this.peekToken();
        if (!this.skipSymbol("set")) {
          this.fail("parseSet: expected set", tag.lineno, tag.colno);
        }
        var node = new nodes.Set(tag.lineno, tag.colno, []);
        var target;
        while (target = this.parsePrimary()) {
          node.targets.push(target);
          if (!this.skip(lexer.TOKEN_COMMA)) {
            break;
          }
        }
        if (!this.skipValue(lexer.TOKEN_OPERATOR, "=")) {
          if (!this.skip(lexer.TOKEN_BLOCK_END)) {
            this.fail("parseSet: expected = or block end in set tag", tag.lineno, tag.colno);
          } else {
            node.body = new nodes.Capture(tag.lineno, tag.colno, this.parseUntilBlocks("endset"));
            node.value = null;
            this.advanceAfterBlockEnd();
          }
        } else {
          node.value = this.parseExpression();
          this.advanceAfterBlockEnd(tag.value);
        }
        return node;
      };
      _proto.parseSwitch = function parseSwitch() {
        var switchStart = "switch";
        var switchEnd = "endswitch";
        var caseStart = "case";
        var caseDefault = "default";
        var tag = this.peekToken();
        if (!this.skipSymbol(switchStart) && !this.skipSymbol(caseStart) && !this.skipSymbol(caseDefault)) {
          this.fail('parseSwitch: expected "switch," "case" or "default"', tag.lineno, tag.colno);
        }
        var expr = this.parseExpression();
        this.advanceAfterBlockEnd(switchStart);
        this.parseUntilBlocks(caseStart, caseDefault, switchEnd);
        var tok = this.peekToken();
        var cases = [];
        var defaultCase;
        do {
          this.skipSymbol(caseStart);
          var cond = this.parseExpression();
          this.advanceAfterBlockEnd(switchStart);
          var body = this.parseUntilBlocks(caseStart, caseDefault, switchEnd);
          cases.push(new nodes.Case(tok.line, tok.col, cond, body));
          tok = this.peekToken();
        } while (tok && tok.value === caseStart);
        switch (tok.value) {
          case caseDefault:
            this.advanceAfterBlockEnd();
            defaultCase = this.parseUntilBlocks(switchEnd);
            this.advanceAfterBlockEnd();
            break;
          case switchEnd:
            this.advanceAfterBlockEnd();
            break;
          default:
            this.fail('parseSwitch: expected "case," "default" or "endswitch," got EOF.');
        }
        return new nodes.Switch(tag.lineno, tag.colno, expr, cases, defaultCase);
      };
      _proto.parseStatement = function parseStatement() {
        var tok = this.peekToken();
        var node;
        if (tok.type !== lexer.TOKEN_SYMBOL) {
          this.fail("tag name expected", tok.lineno, tok.colno);
        }
        if (this.breakOnBlocks && lib.indexOf(this.breakOnBlocks, tok.value) !== -1) {
          return null;
        }
        switch (tok.value) {
          case "raw":
            return this.parseRaw();
          case "verbatim":
            return this.parseRaw("verbatim");
          case "if":
          case "ifAsync":
            return this.parseIf();
          case "for":
          case "asyncEach":
          case "asyncAll":
            return this.parseFor();
          case "block":
            return this.parseBlock();
          case "extends":
            return this.parseExtends();
          case "include":
            return this.parseInclude();
          case "set":
            return this.parseSet();
          case "macro":
            return this.parseMacro();
          case "call":
            return this.parseCall();
          case "import":
            return this.parseImport();
          case "from":
            return this.parseFrom();
          case "filter":
            return this.parseFilterStatement();
          case "switch":
            return this.parseSwitch();
          default:
            if (this.extensions.length) {
              for (var i = 0; i < this.extensions.length; i++) {
                var ext = this.extensions[i];
                if (lib.indexOf(ext.tags || [], tok.value) !== -1) {
                  return ext.parse(this, nodes, lexer);
                }
              }
            }
            this.fail("unknown block tag: " + tok.value, tok.lineno, tok.colno);
        }
        return node;
      };
      _proto.parseRaw = function parseRaw(tagName) {
        tagName = tagName || "raw";
        var endTagName = "end" + tagName;
        var rawBlockRegex = new RegExp("([\\s\\S]*?){%\\s*(" + tagName + "|" + endTagName + ")\\s*(?=%})%}");
        var rawLevel = 1;
        var str = "";
        var matches = null;
        var begun = this.advanceAfterBlockEnd();
        while ((matches = this.tokens._extractRegex(rawBlockRegex)) && rawLevel > 0) {
          var all = matches[0];
          var pre = matches[1];
          var blockName = matches[2];
          if (blockName === tagName) {
            rawLevel += 1;
          } else if (blockName === endTagName) {
            rawLevel -= 1;
          }
          if (rawLevel === 0) {
            str += pre;
            this.tokens.backN(all.length - pre.length);
          } else {
            str += all;
          }
        }
        return new nodes.Output(begun.lineno, begun.colno, [new nodes.TemplateData(begun.lineno, begun.colno, str)]);
      };
      _proto.parsePostfix = function parsePostfix(node) {
        var lookup;
        var tok = this.peekToken();
        while (tok) {
          if (tok.type === lexer.TOKEN_LEFT_PAREN) {
            node = new nodes.FunCall(tok.lineno, tok.colno, node, this.parseSignature());
          } else if (tok.type === lexer.TOKEN_LEFT_BRACKET) {
            lookup = this.parseAggregate();
            if (lookup.children.length > 1) {
              this.fail("invalid index");
            }
            node = new nodes.LookupVal(tok.lineno, tok.colno, node, lookup.children[0]);
          } else if (tok.type === lexer.TOKEN_OPERATOR && tok.value === ".") {
            this.nextToken();
            var val = this.nextToken();
            if (val.type !== lexer.TOKEN_SYMBOL) {
              this.fail("expected name as lookup value, got " + val.value, val.lineno, val.colno);
            }
            lookup = new nodes.Literal(val.lineno, val.colno, val.value);
            node = new nodes.LookupVal(tok.lineno, tok.colno, node, lookup);
          } else {
            break;
          }
          tok = this.peekToken();
        }
        return node;
      };
      _proto.parseExpression = function parseExpression() {
        var node = this.parseInlineIf();
        return node;
      };
      _proto.parseInlineIf = function parseInlineIf() {
        var node = this.parseOr();
        if (this.skipSymbol("if")) {
          var condNode = this.parseOr();
          var bodyNode = node;
          node = new nodes.InlineIf(node.lineno, node.colno);
          node.body = bodyNode;
          node.cond = condNode;
          if (this.skipSymbol("else")) {
            node.else_ = this.parseOr();
          } else {
            node.else_ = null;
          }
        }
        return node;
      };
      _proto.parseOr = function parseOr() {
        var node = this.parseAnd();
        while (this.skipSymbol("or")) {
          var node2 = this.parseAnd();
          node = new nodes.Or(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseAnd = function parseAnd() {
        var node = this.parseNot();
        while (this.skipSymbol("and")) {
          var node2 = this.parseNot();
          node = new nodes.And(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseNot = function parseNot() {
        var tok = this.peekToken();
        if (this.skipSymbol("not")) {
          return new nodes.Not(tok.lineno, tok.colno, this.parseNot());
        }
        return this.parseIn();
      };
      _proto.parseIn = function parseIn() {
        var node = this.parseIs();
        while (1) {
          var tok = this.nextToken();
          if (!tok) {
            break;
          }
          var invert = tok.type === lexer.TOKEN_SYMBOL && tok.value === "not";
          if (!invert) {
            this.pushToken(tok);
          }
          if (this.skipSymbol("in")) {
            var node2 = this.parseIs();
            node = new nodes.In(node.lineno, node.colno, node, node2);
            if (invert) {
              node = new nodes.Not(node.lineno, node.colno, node);
            }
          } else {
            if (invert) {
              this.pushToken(tok);
            }
            break;
          }
        }
        return node;
      };
      _proto.parseIs = function parseIs() {
        var node = this.parseCompare();
        if (this.skipSymbol("is")) {
          var not = this.skipSymbol("not");
          var node2 = this.parseCompare();
          node = new nodes.Is(node.lineno, node.colno, node, node2);
          if (not) {
            node = new nodes.Not(node.lineno, node.colno, node);
          }
        }
        return node;
      };
      _proto.parseCompare = function parseCompare() {
        var compareOps = ["==", "===", "!=", "!==", "<", ">", "<=", ">="];
        var expr = this.parseConcat();
        var ops = [];
        while (1) {
          var tok = this.nextToken();
          if (!tok) {
            break;
          } else if (compareOps.indexOf(tok.value) !== -1) {
            ops.push(new nodes.CompareOperand(tok.lineno, tok.colno, this.parseConcat(), tok.value));
          } else {
            this.pushToken(tok);
            break;
          }
        }
        if (ops.length) {
          return new nodes.Compare(ops[0].lineno, ops[0].colno, expr, ops);
        } else {
          return expr;
        }
      };
      _proto.parseConcat = function parseConcat() {
        var node = this.parseAdd();
        while (this.skipValue(lexer.TOKEN_TILDE, "~")) {
          var node2 = this.parseAdd();
          node = new nodes.Concat(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseAdd = function parseAdd() {
        var node = this.parseSub();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "+")) {
          var node2 = this.parseSub();
          node = new nodes.Add(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseSub = function parseSub() {
        var node = this.parseMul();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "-")) {
          var node2 = this.parseMul();
          node = new nodes.Sub(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseMul = function parseMul() {
        var node = this.parseDiv();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "*")) {
          var node2 = this.parseDiv();
          node = new nodes.Mul(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseDiv = function parseDiv() {
        var node = this.parseFloorDiv();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "/")) {
          var node2 = this.parseFloorDiv();
          node = new nodes.Div(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseFloorDiv = function parseFloorDiv() {
        var node = this.parseMod();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "//")) {
          var node2 = this.parseMod();
          node = new nodes.FloorDiv(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseMod = function parseMod() {
        var node = this.parsePow();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "%")) {
          var node2 = this.parsePow();
          node = new nodes.Mod(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parsePow = function parsePow() {
        var node = this.parseUnary();
        while (this.skipValue(lexer.TOKEN_OPERATOR, "**")) {
          var node2 = this.parseUnary();
          node = new nodes.Pow(node.lineno, node.colno, node, node2);
        }
        return node;
      };
      _proto.parseUnary = function parseUnary(noFilters) {
        var tok = this.peekToken();
        var node;
        if (this.skipValue(lexer.TOKEN_OPERATOR, "-")) {
          node = new nodes.Neg(tok.lineno, tok.colno, this.parseUnary(true));
        } else if (this.skipValue(lexer.TOKEN_OPERATOR, "+")) {
          node = new nodes.Pos(tok.lineno, tok.colno, this.parseUnary(true));
        } else {
          node = this.parsePrimary();
        }
        if (!noFilters) {
          node = this.parseFilter(node);
        }
        return node;
      };
      _proto.parsePrimary = function parsePrimary(noPostfix) {
        var tok = this.nextToken();
        var val;
        var node = null;
        if (!tok) {
          this.fail("expected expression, got end of file");
        } else if (tok.type === lexer.TOKEN_STRING) {
          val = tok.value;
        } else if (tok.type === lexer.TOKEN_INT) {
          val = parseInt(tok.value, 10);
        } else if (tok.type === lexer.TOKEN_FLOAT) {
          val = parseFloat(tok.value);
        } else if (tok.type === lexer.TOKEN_BOOLEAN) {
          if (tok.value === "true") {
            val = true;
          } else if (tok.value === "false") {
            val = false;
          } else {
            this.fail("invalid boolean: " + tok.value, tok.lineno, tok.colno);
          }
        } else if (tok.type === lexer.TOKEN_NONE) {
          val = null;
        } else if (tok.type === lexer.TOKEN_REGEX) {
          val = new RegExp(tok.value.body, tok.value.flags);
        }
        if (val !== void 0) {
          node = new nodes.Literal(tok.lineno, tok.colno, val);
        } else if (tok.type === lexer.TOKEN_SYMBOL) {
          node = new nodes.Symbol(tok.lineno, tok.colno, tok.value);
        } else {
          this.pushToken(tok);
          node = this.parseAggregate();
        }
        if (!noPostfix) {
          node = this.parsePostfix(node);
        }
        if (node) {
          return node;
        } else {
          throw this.error("unexpected token: " + tok.value, tok.lineno, tok.colno);
        }
      };
      _proto.parseFilterName = function parseFilterName() {
        var tok = this.expect(lexer.TOKEN_SYMBOL);
        var name = tok.value;
        while (this.skipValue(lexer.TOKEN_OPERATOR, ".")) {
          name += "." + this.expect(lexer.TOKEN_SYMBOL).value;
        }
        return new nodes.Symbol(tok.lineno, tok.colno, name);
      };
      _proto.parseFilterArgs = function parseFilterArgs(node) {
        if (this.peekToken().type === lexer.TOKEN_LEFT_PAREN) {
          var call = this.parsePostfix(node);
          return call.args.children;
        }
        return [];
      };
      _proto.parseFilter = function parseFilter(node) {
        while (this.skip(lexer.TOKEN_PIPE)) {
          var name = this.parseFilterName();
          node = new nodes.Filter(name.lineno, name.colno, name, new nodes.NodeList(name.lineno, name.colno, [node].concat(this.parseFilterArgs(node))));
        }
        return node;
      };
      _proto.parseFilterStatement = function parseFilterStatement() {
        var filterTok = this.peekToken();
        if (!this.skipSymbol("filter")) {
          this.fail("parseFilterStatement: expected filter");
        }
        var name = this.parseFilterName();
        var args = this.parseFilterArgs(name);
        this.advanceAfterBlockEnd(filterTok.value);
        var body = new nodes.Capture(name.lineno, name.colno, this.parseUntilBlocks("endfilter"));
        this.advanceAfterBlockEnd();
        var node = new nodes.Filter(name.lineno, name.colno, name, new nodes.NodeList(name.lineno, name.colno, [body].concat(args)));
        return new nodes.Output(name.lineno, name.colno, [node]);
      };
      _proto.parseAggregate = function parseAggregate() {
        var tok = this.nextToken();
        var node;
        switch (tok.type) {
          case lexer.TOKEN_LEFT_PAREN:
            node = new nodes.Group(tok.lineno, tok.colno);
            break;
          case lexer.TOKEN_LEFT_BRACKET:
            node = new nodes.Array(tok.lineno, tok.colno);
            break;
          case lexer.TOKEN_LEFT_CURLY:
            node = new nodes.Dict(tok.lineno, tok.colno);
            break;
          default:
            return null;
        }
        while (1) {
          var type = this.peekToken().type;
          if (type === lexer.TOKEN_RIGHT_PAREN || type === lexer.TOKEN_RIGHT_BRACKET || type === lexer.TOKEN_RIGHT_CURLY) {
            this.nextToken();
            break;
          }
          if (node.children.length > 0) {
            if (!this.skip(lexer.TOKEN_COMMA)) {
              this.fail("parseAggregate: expected comma after expression", tok.lineno, tok.colno);
            }
          }
          if (node instanceof nodes.Dict) {
            var key = this.parsePrimary();
            if (!this.skip(lexer.TOKEN_COLON)) {
              this.fail("parseAggregate: expected colon after dict key", tok.lineno, tok.colno);
            }
            var value = this.parseExpression();
            node.addChild(new nodes.Pair(key.lineno, key.colno, key, value));
          } else {
            var expr = this.parseExpression();
            node.addChild(expr);
          }
        }
        return node;
      };
      _proto.parseSignature = function parseSignature(tolerant, noParens) {
        var tok = this.peekToken();
        if (!noParens && tok.type !== lexer.TOKEN_LEFT_PAREN) {
          if (tolerant) {
            return null;
          } else {
            this.fail("expected arguments", tok.lineno, tok.colno);
          }
        }
        if (tok.type === lexer.TOKEN_LEFT_PAREN) {
          tok = this.nextToken();
        }
        var args = new nodes.NodeList(tok.lineno, tok.colno);
        var kwargs = new nodes.KeywordArgs(tok.lineno, tok.colno);
        var checkComma = false;
        while (1) {
          tok = this.peekToken();
          if (!noParens && tok.type === lexer.TOKEN_RIGHT_PAREN) {
            this.nextToken();
            break;
          } else if (noParens && tok.type === lexer.TOKEN_BLOCK_END) {
            break;
          }
          if (checkComma && !this.skip(lexer.TOKEN_COMMA)) {
            this.fail("parseSignature: expected comma after expression", tok.lineno, tok.colno);
          } else {
            var arg = this.parseExpression();
            if (this.skipValue(lexer.TOKEN_OPERATOR, "=")) {
              kwargs.addChild(new nodes.Pair(arg.lineno, arg.colno, arg, this.parseExpression()));
            } else {
              args.addChild(arg);
            }
          }
          checkComma = true;
        }
        if (kwargs.children.length) {
          args.addChild(kwargs);
        }
        return args;
      };
      _proto.parseUntilBlocks = function parseUntilBlocks() {
        var prev = this.breakOnBlocks;
        for (var _len = arguments.length, blockNames = new Array(_len), _key = 0; _key < _len; _key++) {
          blockNames[_key] = arguments[_key];
        }
        this.breakOnBlocks = blockNames;
        var ret = this.parse();
        this.breakOnBlocks = prev;
        return ret;
      };
      _proto.parseNodes = function parseNodes() {
        var tok;
        var buf = [];
        while (tok = this.nextToken()) {
          if (tok.type === lexer.TOKEN_DATA) {
            var data = tok.value;
            var nextToken = this.peekToken();
            var nextVal = nextToken && nextToken.value;
            if (this.dropLeadingWhitespace) {
              data = data.replace(/^\s*/, "");
              this.dropLeadingWhitespace = false;
            }
            if (nextToken && (nextToken.type === lexer.TOKEN_BLOCK_START && nextVal.charAt(nextVal.length - 1) === "-" || nextToken.type === lexer.TOKEN_VARIABLE_START && nextVal.charAt(this.tokens.tags.VARIABLE_START.length) === "-" || nextToken.type === lexer.TOKEN_COMMENT && nextVal.charAt(this.tokens.tags.COMMENT_START.length) === "-")) {
              data = data.replace(/\s*$/, "");
            }
            buf.push(new nodes.Output(tok.lineno, tok.colno, [new nodes.TemplateData(tok.lineno, tok.colno, data)]));
          } else if (tok.type === lexer.TOKEN_BLOCK_START) {
            this.dropLeadingWhitespace = false;
            var n = this.parseStatement();
            if (!n) {
              break;
            }
            buf.push(n);
          } else if (tok.type === lexer.TOKEN_VARIABLE_START) {
            var e = this.parseExpression();
            this.dropLeadingWhitespace = false;
            this.advanceAfterVariableEnd();
            buf.push(new nodes.Output(tok.lineno, tok.colno, [e]));
          } else if (tok.type === lexer.TOKEN_COMMENT) {
            this.dropLeadingWhitespace = tok.value.charAt(tok.value.length - this.tokens.tags.COMMENT_END.length - 1) === "-";
          } else {
            this.fail("Unexpected token at top-level: " + tok.type, tok.lineno, tok.colno);
          }
        }
        return buf;
      };
      _proto.parse = function parse() {
        return new nodes.NodeList(0, 0, this.parseNodes());
      };
      _proto.parseAsRoot = function parseAsRoot() {
        return new nodes.Root(0, 0, this.parseNodes());
      };
      return Parser2;
    })(Obj);
    module.exports = {
      parse: function parse(src, extensions, opts) {
        var p = new Parser(lexer.lex(src, opts));
        if (extensions !== void 0) {
          p.extensions = extensions;
        }
        return p.parseAsRoot();
      },
      Parser
    };
  }
});

// node_modules/nunjucks/src/transformer.js
var require_transformer = __commonJS({
  "node_modules/nunjucks/src/transformer.js"(exports, module) {
    "use strict";
    var nodes = require_nodes();
    var lib = require_lib();
    var sym = 0;
    function gensym() {
      return "hole_" + sym++;
    }
    function mapCOW(arr, func) {
      var res = null;
      for (var i = 0; i < arr.length; i++) {
        var item = func(arr[i]);
        if (item !== arr[i]) {
          if (!res) {
            res = arr.slice();
          }
          res[i] = item;
        }
      }
      return res || arr;
    }
    function walk(ast, func, depthFirst) {
      if (!(ast instanceof nodes.Node)) {
        return ast;
      }
      if (!depthFirst) {
        var astT = func(ast);
        if (astT && astT !== ast) {
          return astT;
        }
      }
      if (ast instanceof nodes.NodeList) {
        var children = mapCOW(ast.children, function(node) {
          return walk(node, func, depthFirst);
        });
        if (children !== ast.children) {
          ast = new nodes[ast.typename](ast.lineno, ast.colno, children);
        }
      } else if (ast instanceof nodes.CallExtension) {
        var args = walk(ast.args, func, depthFirst);
        var contentArgs = mapCOW(ast.contentArgs, function(node) {
          return walk(node, func, depthFirst);
        });
        if (args !== ast.args || contentArgs !== ast.contentArgs) {
          ast = new nodes[ast.typename](ast.extName, ast.prop, args, contentArgs);
        }
      } else {
        var props = ast.fields.map(function(field) {
          return ast[field];
        });
        var propsT = mapCOW(props, function(prop) {
          return walk(prop, func, depthFirst);
        });
        if (propsT !== props) {
          ast = new nodes[ast.typename](ast.lineno, ast.colno);
          propsT.forEach(function(prop, i) {
            ast[ast.fields[i]] = prop;
          });
        }
      }
      return depthFirst ? func(ast) || ast : ast;
    }
    function depthWalk(ast, func) {
      return walk(ast, func, true);
    }
    function _liftFilters(node, asyncFilters, prop) {
      var children = [];
      var walked = depthWalk(prop ? node[prop] : node, function(descNode) {
        var symbol;
        if (descNode instanceof nodes.Block) {
          return descNode;
        } else if (descNode instanceof nodes.Filter && lib.indexOf(asyncFilters, descNode.name.value) !== -1 || descNode instanceof nodes.CallExtensionAsync) {
          symbol = new nodes.Symbol(descNode.lineno, descNode.colno, gensym());
          children.push(new nodes.FilterAsync(descNode.lineno, descNode.colno, descNode.name, descNode.args, symbol));
        }
        return symbol;
      });
      if (prop) {
        node[prop] = walked;
      } else {
        node = walked;
      }
      if (children.length) {
        children.push(node);
        return new nodes.NodeList(node.lineno, node.colno, children);
      } else {
        return node;
      }
    }
    function liftFilters(ast, asyncFilters) {
      return depthWalk(ast, function(node) {
        if (node instanceof nodes.Output) {
          return _liftFilters(node, asyncFilters);
        } else if (node instanceof nodes.Set) {
          return _liftFilters(node, asyncFilters, "value");
        } else if (node instanceof nodes.For) {
          return _liftFilters(node, asyncFilters, "arr");
        } else if (node instanceof nodes.If) {
          return _liftFilters(node, asyncFilters, "cond");
        } else if (node instanceof nodes.CallExtension) {
          return _liftFilters(node, asyncFilters, "args");
        } else {
          return void 0;
        }
      });
    }
    function liftSuper(ast) {
      return walk(ast, function(blockNode) {
        if (!(blockNode instanceof nodes.Block)) {
          return;
        }
        var hasSuper = false;
        var symbol = gensym();
        blockNode.body = walk(blockNode.body, function(node) {
          if (node instanceof nodes.FunCall && node.name.value === "super") {
            hasSuper = true;
            return new nodes.Symbol(node.lineno, node.colno, symbol);
          }
        });
        if (hasSuper) {
          blockNode.body.children.unshift(new nodes.Super(0, 0, blockNode.name, new nodes.Symbol(0, 0, symbol)));
        }
      });
    }
    function convertStatements(ast) {
      return depthWalk(ast, function(node) {
        if (!(node instanceof nodes.If) && !(node instanceof nodes.For)) {
          return void 0;
        }
        var async = false;
        walk(node, function(child) {
          if (child instanceof nodes.FilterAsync || child instanceof nodes.IfAsync || child instanceof nodes.AsyncEach || child instanceof nodes.AsyncAll || child instanceof nodes.CallExtensionAsync) {
            async = true;
            return child;
          }
          return void 0;
        });
        if (async) {
          if (node instanceof nodes.If) {
            return new nodes.IfAsync(node.lineno, node.colno, node.cond, node.body, node.else_);
          } else if (node instanceof nodes.For && !(node instanceof nodes.AsyncAll)) {
            return new nodes.AsyncEach(node.lineno, node.colno, node.arr, node.name, node.body, node.else_);
          }
        }
        return void 0;
      });
    }
    function cps(ast, asyncFilters) {
      return convertStatements(liftSuper(liftFilters(ast, asyncFilters)));
    }
    function transform(ast, asyncFilters) {
      return cps(ast, asyncFilters || []);
    }
    module.exports = {
      transform
    };
  }
});

// node_modules/nunjucks/src/runtime.js
var require_runtime = __commonJS({
  "node_modules/nunjucks/src/runtime.js"(exports, module) {
    "use strict";
    var lib = require_lib();
    var arrayFrom = Array.from;
    var supportsIterators = typeof Symbol === "function" && Symbol.iterator && typeof arrayFrom === "function";
    var Frame = /* @__PURE__ */ (function() {
      function Frame2(parent, isolateWrites) {
        this.variables = /* @__PURE__ */ Object.create(null);
        this.parent = parent;
        this.topLevel = false;
        this.isolateWrites = isolateWrites;
      }
      var _proto = Frame2.prototype;
      _proto.set = function set(name, val, resolveUp) {
        var parts = name.split(".");
        var obj = this.variables;
        var frame = this;
        if (resolveUp) {
          if (frame = this.resolve(parts[0], true)) {
            frame.set(name, val);
            return;
          }
        }
        for (var i = 0; i < parts.length - 1; i++) {
          var id = parts[i];
          if (!obj[id]) {
            obj[id] = {};
          }
          obj = obj[id];
        }
        obj[parts[parts.length - 1]] = val;
      };
      _proto.get = function get(name) {
        var val = this.variables[name];
        if (val !== void 0) {
          return val;
        }
        return null;
      };
      _proto.lookup = function lookup(name) {
        var p = this.parent;
        var val = this.variables[name];
        if (val !== void 0) {
          return val;
        }
        return p && p.lookup(name);
      };
      _proto.resolve = function resolve(name, forWrite) {
        var p = forWrite && this.isolateWrites ? void 0 : this.parent;
        var val = this.variables[name];
        if (val !== void 0) {
          return this;
        }
        return p && p.resolve(name);
      };
      _proto.push = function push(isolateWrites) {
        return new Frame2(this, isolateWrites);
      };
      _proto.pop = function pop() {
        return this.parent;
      };
      return Frame2;
    })();
    function makeMacro(argNames, kwargNames, func) {
      return function macro() {
        for (var _len = arguments.length, macroArgs = new Array(_len), _key = 0; _key < _len; _key++) {
          macroArgs[_key] = arguments[_key];
        }
        var argCount = numArgs(macroArgs);
        var args;
        var kwargs = getKeywordArgs(macroArgs);
        if (argCount > argNames.length) {
          args = macroArgs.slice(0, argNames.length);
          macroArgs.slice(args.length, argCount).forEach(function(val, i2) {
            if (i2 < kwargNames.length) {
              kwargs[kwargNames[i2]] = val;
            }
          });
          args.push(kwargs);
        } else if (argCount < argNames.length) {
          args = macroArgs.slice(0, argCount);
          for (var i = argCount; i < argNames.length; i++) {
            var arg = argNames[i];
            args.push(kwargs[arg]);
            delete kwargs[arg];
          }
          args.push(kwargs);
        } else {
          args = macroArgs;
        }
        return func.apply(this, args);
      };
    }
    function makeKeywordArgs(obj) {
      obj.__keywords = true;
      return obj;
    }
    function isKeywordArgs(obj) {
      return obj && Object.prototype.hasOwnProperty.call(obj, "__keywords");
    }
    function getKeywordArgs(args) {
      var len = args.length;
      if (len) {
        var lastArg = args[len - 1];
        if (isKeywordArgs(lastArg)) {
          return lastArg;
        }
      }
      return {};
    }
    function numArgs(args) {
      var len = args.length;
      if (len === 0) {
        return 0;
      }
      var lastArg = args[len - 1];
      if (isKeywordArgs(lastArg)) {
        return len - 1;
      } else {
        return len;
      }
    }
    function SafeString(val) {
      if (typeof val !== "string") {
        return val;
      }
      this.val = val;
      this.length = val.length;
    }
    SafeString.prototype = Object.create(String.prototype, {
      length: {
        writable: true,
        configurable: true,
        value: 0
      }
    });
    SafeString.prototype.valueOf = function valueOf() {
      return this.val;
    };
    SafeString.prototype.toString = function toString() {
      return this.val;
    };
    function copySafeness(dest, target) {
      if (dest instanceof SafeString) {
        return new SafeString(target);
      }
      return target.toString();
    }
    function markSafe(val) {
      var type = typeof val;
      if (type === "string") {
        return new SafeString(val);
      } else if (type !== "function") {
        return val;
      } else {
        return function wrapSafe(args) {
          var ret = val.apply(this, arguments);
          if (typeof ret === "string") {
            return new SafeString(ret);
          }
          return ret;
        };
      }
    }
    function suppressValue(val, autoescape) {
      val = val !== void 0 && val !== null ? val : "";
      if (autoescape && !(val instanceof SafeString)) {
        val = lib.escape(val.toString());
      }
      return val;
    }
    function ensureDefined(val, lineno, colno) {
      if (val === null || val === void 0) {
        throw new lib.TemplateError("attempted to output null or undefined value", lineno + 1, colno + 1);
      }
      return val;
    }
    function memberLookup(obj, val) {
      if (obj === void 0 || obj === null) {
        return void 0;
      }
      if (typeof obj[val] === "function") {
        return function() {
          for (var _len2 = arguments.length, args = new Array(_len2), _key2 = 0; _key2 < _len2; _key2++) {
            args[_key2] = arguments[_key2];
          }
          return obj[val].apply(obj, args);
        };
      }
      return obj[val];
    }
    function callWrap(obj, name, context, args) {
      if (!obj) {
        throw new Error("Unable to call `" + name + "`, which is undefined or falsey");
      } else if (typeof obj !== "function") {
        throw new Error("Unable to call `" + name + "`, which is not a function");
      }
      return obj.apply(context, args);
    }
    function contextOrFrameLookup(context, frame, name) {
      var val = frame.lookup(name);
      return val !== void 0 ? val : context.lookup(name);
    }
    function handleError(error, lineno, colno) {
      if (error.lineno) {
        return error;
      } else {
        return new lib.TemplateError(error, lineno, colno);
      }
    }
    function asyncEach(arr, dimen, iter, cb) {
      if (lib.isArray(arr)) {
        var len = arr.length;
        lib.asyncIter(arr, function iterCallback(item, i, next) {
          switch (dimen) {
            case 1:
              iter(item, i, len, next);
              break;
            case 2:
              iter(item[0], item[1], i, len, next);
              break;
            case 3:
              iter(item[0], item[1], item[2], i, len, next);
              break;
            default:
              item.push(i, len, next);
              iter.apply(this, item);
          }
        }, cb);
      } else {
        lib.asyncFor(arr, function iterCallback(key, val, i, len2, next) {
          iter(key, val, i, len2, next);
        }, cb);
      }
    }
    function asyncAll(arr, dimen, func, cb) {
      var finished = 0;
      var len;
      var outputArr;
      function done(i2, output) {
        finished++;
        outputArr[i2] = output;
        if (finished === len) {
          cb(null, outputArr.join(""));
        }
      }
      if (lib.isArray(arr)) {
        len = arr.length;
        outputArr = new Array(len);
        if (len === 0) {
          cb(null, "");
        } else {
          for (var i = 0; i < arr.length; i++) {
            var item = arr[i];
            switch (dimen) {
              case 1:
                func(item, i, len, done);
                break;
              case 2:
                func(item[0], item[1], i, len, done);
                break;
              case 3:
                func(item[0], item[1], item[2], i, len, done);
                break;
              default:
                item.push(i, len, done);
                func.apply(this, item);
            }
          }
        }
      } else {
        var keys = lib.keys(arr || {});
        len = keys.length;
        outputArr = new Array(len);
        if (len === 0) {
          cb(null, "");
        } else {
          for (var _i = 0; _i < keys.length; _i++) {
            var k = keys[_i];
            func(k, arr[k], _i, len, done);
          }
        }
      }
    }
    function fromIterator(arr) {
      if (typeof arr !== "object" || arr === null || lib.isArray(arr)) {
        return arr;
      } else if (supportsIterators && Symbol.iterator in arr) {
        return arrayFrom(arr);
      } else {
        return arr;
      }
    }
    module.exports = {
      Frame,
      makeMacro,
      makeKeywordArgs,
      numArgs,
      suppressValue,
      ensureDefined,
      memberLookup,
      contextOrFrameLookup,
      callWrap,
      handleError,
      isArray: lib.isArray,
      keys: lib.keys,
      SafeString,
      copySafeness,
      markSafe,
      asyncEach,
      asyncAll,
      inOperator: lib.inOperator,
      fromIterator
    };
  }
});

// node_modules/nunjucks/src/compiler.js
var require_compiler = __commonJS({
  "node_modules/nunjucks/src/compiler.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var parser = require_parser();
    var transformer = require_transformer();
    var nodes = require_nodes();
    var _require = require_lib();
    var TemplateError = _require.TemplateError;
    var _require2 = require_runtime();
    var Frame = _require2.Frame;
    var _require3 = require_object();
    var Obj = _require3.Obj;
    var compareOps = {
      "==": "==",
      "===": "===",
      "!=": "!=",
      "!==": "!==",
      "<": "<",
      ">": ">",
      "<=": "<=",
      ">=": ">="
    };
    var Compiler = /* @__PURE__ */ (function(_Obj) {
      _inheritsLoose(Compiler2, _Obj);
      function Compiler2() {
        return _Obj.apply(this, arguments) || this;
      }
      var _proto = Compiler2.prototype;
      _proto.init = function init(templateName, throwOnUndefined) {
        this.templateName = templateName;
        this.codebuf = [];
        this.lastId = 0;
        this.buffer = null;
        this.bufferStack = [];
        this._scopeClosers = "";
        this.inBlock = false;
        this.throwOnUndefined = throwOnUndefined;
      };
      _proto.fail = function fail(msg, lineno, colno) {
        if (lineno !== void 0) {
          lineno += 1;
        }
        if (colno !== void 0) {
          colno += 1;
        }
        throw new TemplateError(msg, lineno, colno);
      };
      _proto._pushBuffer = function _pushBuffer() {
        var id = this._tmpid();
        this.bufferStack.push(this.buffer);
        this.buffer = id;
        this._emit("var " + this.buffer + ' = "";');
        return id;
      };
      _proto._popBuffer = function _popBuffer() {
        this.buffer = this.bufferStack.pop();
      };
      _proto._emit = function _emit(code) {
        this.codebuf.push(code);
      };
      _proto._emitLine = function _emitLine(code) {
        this._emit(code + "\n");
      };
      _proto._emitLines = function _emitLines() {
        var _this = this;
        for (var _len = arguments.length, lines = new Array(_len), _key = 0; _key < _len; _key++) {
          lines[_key] = arguments[_key];
        }
        lines.forEach(function(line) {
          return _this._emitLine(line);
        });
      };
      _proto._emitFuncBegin = function _emitFuncBegin(node, name) {
        this.buffer = "output";
        this._scopeClosers = "";
        this._emitLine("function " + name + "(env, context, frame, runtime, cb) {");
        this._emitLine("var lineno = " + node.lineno + ";");
        this._emitLine("var colno = " + node.colno + ";");
        this._emitLine("var " + this.buffer + ' = "";');
        this._emitLine("try {");
      };
      _proto._emitFuncEnd = function _emitFuncEnd(noReturn) {
        if (!noReturn) {
          this._emitLine("cb(null, " + this.buffer + ");");
        }
        this._closeScopeLevels();
        this._emitLine("} catch (e) {");
        this._emitLine("  cb(runtime.handleError(e, lineno, colno));");
        this._emitLine("}");
        this._emitLine("}");
        this.buffer = null;
      };
      _proto._addScopeLevel = function _addScopeLevel() {
        this._scopeClosers += "})";
      };
      _proto._closeScopeLevels = function _closeScopeLevels() {
        this._emitLine(this._scopeClosers + ";");
        this._scopeClosers = "";
      };
      _proto._withScopedSyntax = function _withScopedSyntax(func) {
        var _scopeClosers = this._scopeClosers;
        this._scopeClosers = "";
        func.call(this);
        this._closeScopeLevels();
        this._scopeClosers = _scopeClosers;
      };
      _proto._makeCallback = function _makeCallback(res) {
        var err = this._tmpid();
        return "function(" + err + (res ? "," + res : "") + ") {\nif(" + err + ") { cb(" + err + "); return; }";
      };
      _proto._tmpid = function _tmpid() {
        this.lastId++;
        return "t_" + this.lastId;
      };
      _proto._templateName = function _templateName() {
        return this.templateName == null ? "undefined" : JSON.stringify(this.templateName);
      };
      _proto._compileChildren = function _compileChildren(node, frame) {
        var _this2 = this;
        node.children.forEach(function(child) {
          _this2.compile(child, frame);
        });
      };
      _proto._compileAggregate = function _compileAggregate(node, frame, startChar, endChar) {
        var _this3 = this;
        if (startChar) {
          this._emit(startChar);
        }
        node.children.forEach(function(child, i) {
          if (i > 0) {
            _this3._emit(",");
          }
          _this3.compile(child, frame);
        });
        if (endChar) {
          this._emit(endChar);
        }
      };
      _proto._compileExpression = function _compileExpression(node, frame) {
        this.assertType(node, nodes.Literal, nodes.Symbol, nodes.Group, nodes.Array, nodes.Dict, nodes.FunCall, nodes.Caller, nodes.Filter, nodes.LookupVal, nodes.Compare, nodes.InlineIf, nodes.In, nodes.Is, nodes.And, nodes.Or, nodes.Not, nodes.Add, nodes.Concat, nodes.Sub, nodes.Mul, nodes.Div, nodes.FloorDiv, nodes.Mod, nodes.Pow, nodes.Neg, nodes.Pos, nodes.Compare, nodes.NodeList);
        this.compile(node, frame);
      };
      _proto.assertType = function assertType(node) {
        for (var _len2 = arguments.length, types = new Array(_len2 > 1 ? _len2 - 1 : 0), _key2 = 1; _key2 < _len2; _key2++) {
          types[_key2 - 1] = arguments[_key2];
        }
        if (!types.some(function(t) {
          return node instanceof t;
        })) {
          this.fail("assertType: invalid type: " + node.typename, node.lineno, node.colno);
        }
      };
      _proto.compileCallExtension = function compileCallExtension(node, frame, async) {
        var _this4 = this;
        var args = node.args;
        var contentArgs = node.contentArgs;
        var autoescape = typeof node.autoescape === "boolean" ? node.autoescape : true;
        if (!async) {
          this._emit(this.buffer + " += runtime.suppressValue(");
        }
        this._emit('env.getExtension("' + node.extName + '")["' + node.prop + '"](');
        this._emit("context");
        if (args || contentArgs) {
          this._emit(",");
        }
        if (args) {
          if (!(args instanceof nodes.NodeList)) {
            this.fail("compileCallExtension: arguments must be a NodeList, use `parser.parseSignature`");
          }
          args.children.forEach(function(arg, i) {
            _this4._compileExpression(arg, frame);
            if (i !== args.children.length - 1 || contentArgs.length) {
              _this4._emit(",");
            }
          });
        }
        if (contentArgs.length) {
          contentArgs.forEach(function(arg, i) {
            if (i > 0) {
              _this4._emit(",");
            }
            if (arg) {
              _this4._emitLine("function(cb) {");
              _this4._emitLine("if(!cb) { cb = function(err) { if(err) { throw err; }}}");
              var id = _this4._pushBuffer();
              _this4._withScopedSyntax(function() {
                _this4.compile(arg, frame);
                _this4._emitLine("cb(null, " + id + ");");
              });
              _this4._popBuffer();
              _this4._emitLine("return " + id + ";");
              _this4._emitLine("}");
            } else {
              _this4._emit("null");
            }
          });
        }
        if (async) {
          var res = this._tmpid();
          this._emitLine(", " + this._makeCallback(res));
          this._emitLine(this.buffer + " += runtime.suppressValue(" + res + ", " + autoescape + " && env.opts.autoescape);");
          this._addScopeLevel();
        } else {
          this._emit(")");
          this._emit(", " + autoescape + " && env.opts.autoescape);\n");
        }
      };
      _proto.compileCallExtensionAsync = function compileCallExtensionAsync(node, frame) {
        this.compileCallExtension(node, frame, true);
      };
      _proto.compileNodeList = function compileNodeList(node, frame) {
        this._compileChildren(node, frame);
      };
      _proto.compileLiteral = function compileLiteral(node) {
        if (typeof node.value === "string") {
          var val = node.value.replace(/\\/g, "\\\\");
          val = val.replace(/"/g, '\\"');
          val = val.replace(/\n/g, "\\n");
          val = val.replace(/\r/g, "\\r");
          val = val.replace(/\t/g, "\\t");
          val = val.replace(/\u2028/g, "\\u2028");
          this._emit('"' + val + '"');
        } else if (node.value === null) {
          this._emit("null");
        } else {
          this._emit(node.value.toString());
        }
      };
      _proto.compileSymbol = function compileSymbol(node, frame) {
        var name = node.value;
        var v = frame.lookup(name);
        if (v) {
          this._emit(v);
        } else {
          this._emit('runtime.contextOrFrameLookup(context, frame, "' + name + '")');
        }
      };
      _proto.compileGroup = function compileGroup(node, frame) {
        this._compileAggregate(node, frame, "(", ")");
      };
      _proto.compileArray = function compileArray(node, frame) {
        this._compileAggregate(node, frame, "[", "]");
      };
      _proto.compileDict = function compileDict(node, frame) {
        this._compileAggregate(node, frame, "{", "}");
      };
      _proto.compilePair = function compilePair(node, frame) {
        var key = node.key;
        var val = node.value;
        if (key instanceof nodes.Symbol) {
          key = new nodes.Literal(key.lineno, key.colno, key.value);
        } else if (!(key instanceof nodes.Literal && typeof key.value === "string")) {
          this.fail("compilePair: Dict keys must be strings or names", key.lineno, key.colno);
        }
        this.compile(key, frame);
        this._emit(": ");
        this._compileExpression(val, frame);
      };
      _proto.compileInlineIf = function compileInlineIf(node, frame) {
        this._emit("(");
        this.compile(node.cond, frame);
        this._emit("?");
        this.compile(node.body, frame);
        this._emit(":");
        if (node.else_ !== null) {
          this.compile(node.else_, frame);
        } else {
          this._emit('""');
        }
        this._emit(")");
      };
      _proto.compileIn = function compileIn(node, frame) {
        this._emit("runtime.inOperator(");
        this.compile(node.left, frame);
        this._emit(",");
        this.compile(node.right, frame);
        this._emit(")");
      };
      _proto.compileIs = function compileIs(node, frame) {
        var right = node.right.name ? node.right.name.value : node.right.value;
        this._emit('env.getTest("' + right + '").call(context, ');
        this.compile(node.left, frame);
        if (node.right.args) {
          this._emit(",");
          this.compile(node.right.args, frame);
        }
        this._emit(") === true");
      };
      _proto._binOpEmitter = function _binOpEmitter(node, frame, str) {
        this.compile(node.left, frame);
        this._emit(str);
        this.compile(node.right, frame);
      };
      _proto.compileOr = function compileOr(node, frame) {
        return this._binOpEmitter(node, frame, " || ");
      };
      _proto.compileAnd = function compileAnd(node, frame) {
        return this._binOpEmitter(node, frame, " && ");
      };
      _proto.compileAdd = function compileAdd(node, frame) {
        return this._binOpEmitter(node, frame, " + ");
      };
      _proto.compileConcat = function compileConcat(node, frame) {
        return this._binOpEmitter(node, frame, ' + "" + ');
      };
      _proto.compileSub = function compileSub(node, frame) {
        return this._binOpEmitter(node, frame, " - ");
      };
      _proto.compileMul = function compileMul(node, frame) {
        return this._binOpEmitter(node, frame, " * ");
      };
      _proto.compileDiv = function compileDiv(node, frame) {
        return this._binOpEmitter(node, frame, " / ");
      };
      _proto.compileMod = function compileMod(node, frame) {
        return this._binOpEmitter(node, frame, " % ");
      };
      _proto.compileNot = function compileNot(node, frame) {
        this._emit("!");
        this.compile(node.target, frame);
      };
      _proto.compileFloorDiv = function compileFloorDiv(node, frame) {
        this._emit("Math.floor(");
        this.compile(node.left, frame);
        this._emit(" / ");
        this.compile(node.right, frame);
        this._emit(")");
      };
      _proto.compilePow = function compilePow(node, frame) {
        this._emit("Math.pow(");
        this.compile(node.left, frame);
        this._emit(", ");
        this.compile(node.right, frame);
        this._emit(")");
      };
      _proto.compileNeg = function compileNeg(node, frame) {
        this._emit("-");
        this.compile(node.target, frame);
      };
      _proto.compilePos = function compilePos(node, frame) {
        this._emit("+");
        this.compile(node.target, frame);
      };
      _proto.compileCompare = function compileCompare(node, frame) {
        var _this5 = this;
        this.compile(node.expr, frame);
        node.ops.forEach(function(op) {
          _this5._emit(" " + compareOps[op.type] + " ");
          _this5.compile(op.expr, frame);
        });
      };
      _proto.compileLookupVal = function compileLookupVal(node, frame) {
        this._emit("runtime.memberLookup((");
        this._compileExpression(node.target, frame);
        this._emit("),");
        this._compileExpression(node.val, frame);
        this._emit(")");
      };
      _proto._getNodeName = function _getNodeName(node) {
        switch (node.typename) {
          case "Symbol":
            return node.value;
          case "FunCall":
            return "the return value of (" + this._getNodeName(node.name) + ")";
          case "LookupVal":
            return this._getNodeName(node.target) + '["' + this._getNodeName(node.val) + '"]';
          case "Literal":
            return node.value.toString();
          default:
            return "--expression--";
        }
      };
      _proto.compileFunCall = function compileFunCall(node, frame) {
        this._emit("(lineno = " + node.lineno + ", colno = " + node.colno + ", ");
        this._emit("runtime.callWrap(");
        this._compileExpression(node.name, frame);
        this._emit(', "' + this._getNodeName(node.name).replace(/"/g, '\\"') + '", context, ');
        this._compileAggregate(node.args, frame, "[", "])");
        this._emit(")");
      };
      _proto.compileFilter = function compileFilter(node, frame) {
        var name = node.name;
        this.assertType(name, nodes.Symbol);
        this._emit('env.getFilter("' + name.value + '").call(context, ');
        this._compileAggregate(node.args, frame);
        this._emit(")");
      };
      _proto.compileFilterAsync = function compileFilterAsync(node, frame) {
        var name = node.name;
        var symbol = node.symbol.value;
        this.assertType(name, nodes.Symbol);
        frame.set(symbol, symbol);
        this._emit('env.getFilter("' + name.value + '").call(context, ');
        this._compileAggregate(node.args, frame);
        this._emitLine(", " + this._makeCallback(symbol));
        this._addScopeLevel();
      };
      _proto.compileKeywordArgs = function compileKeywordArgs(node, frame) {
        this._emit("runtime.makeKeywordArgs(");
        this.compileDict(node, frame);
        this._emit(")");
      };
      _proto.compileSet = function compileSet(node, frame) {
        var _this6 = this;
        var ids = [];
        node.targets.forEach(function(target) {
          var name = target.value;
          var id = frame.lookup(name);
          if (id === null || id === void 0) {
            id = _this6._tmpid();
            _this6._emitLine("var " + id + ";");
          }
          ids.push(id);
        });
        if (node.value) {
          this._emit(ids.join(" = ") + " = ");
          this._compileExpression(node.value, frame);
          this._emitLine(";");
        } else {
          this._emit(ids.join(" = ") + " = ");
          this.compile(node.body, frame);
          this._emitLine(";");
        }
        node.targets.forEach(function(target, i) {
          var id = ids[i];
          var name = target.value;
          _this6._emitLine('frame.set("' + name + '", ' + id + ", true);");
          _this6._emitLine("if(frame.topLevel) {");
          _this6._emitLine('context.setVariable("' + name + '", ' + id + ");");
          _this6._emitLine("}");
          if (name.charAt(0) !== "_") {
            _this6._emitLine("if(frame.topLevel) {");
            _this6._emitLine('context.addExport("' + name + '", ' + id + ");");
            _this6._emitLine("}");
          }
        });
      };
      _proto.compileSwitch = function compileSwitch(node, frame) {
        var _this7 = this;
        this._emit("switch (");
        this.compile(node.expr, frame);
        this._emit(") {");
        node.cases.forEach(function(c, i) {
          _this7._emit("case ");
          _this7.compile(c.cond, frame);
          _this7._emit(": ");
          _this7.compile(c.body, frame);
          if (c.body.children.length) {
            _this7._emitLine("break;");
          }
        });
        if (node.default) {
          this._emit("default:");
          this.compile(node.default, frame);
        }
        this._emit("}");
      };
      _proto.compileIf = function compileIf(node, frame, async) {
        var _this8 = this;
        this._emit("if(");
        this._compileExpression(node.cond, frame);
        this._emitLine(") {");
        this._withScopedSyntax(function() {
          _this8.compile(node.body, frame);
          if (async) {
            _this8._emit("cb()");
          }
        });
        if (node.else_) {
          this._emitLine("}\nelse {");
          this._withScopedSyntax(function() {
            _this8.compile(node.else_, frame);
            if (async) {
              _this8._emit("cb()");
            }
          });
        } else if (async) {
          this._emitLine("}\nelse {");
          this._emit("cb()");
        }
        this._emitLine("}");
      };
      _proto.compileIfAsync = function compileIfAsync(node, frame) {
        this._emit("(function(cb) {");
        this.compileIf(node, frame, true);
        this._emit("})(" + this._makeCallback());
        this._addScopeLevel();
      };
      _proto._emitLoopBindings = function _emitLoopBindings(node, arr, i, len) {
        var _this9 = this;
        var bindings = [{
          name: "index",
          val: i + " + 1"
        }, {
          name: "index0",
          val: i
        }, {
          name: "revindex",
          val: len + " - " + i
        }, {
          name: "revindex0",
          val: len + " - " + i + " - 1"
        }, {
          name: "first",
          val: i + " === 0"
        }, {
          name: "last",
          val: i + " === " + len + " - 1"
        }, {
          name: "length",
          val: len
        }];
        bindings.forEach(function(b) {
          _this9._emitLine('frame.set("loop.' + b.name + '", ' + b.val + ");");
        });
      };
      _proto.compileFor = function compileFor(node, frame) {
        var _this10 = this;
        var i = this._tmpid();
        var len = this._tmpid();
        var arr = this._tmpid();
        frame = frame.push();
        this._emitLine("frame = frame.push();");
        this._emit("var " + arr + " = ");
        this._compileExpression(node.arr, frame);
        this._emitLine(";");
        this._emit("if(" + arr + ") {");
        this._emitLine(arr + " = runtime.fromIterator(" + arr + ");");
        if (node.name instanceof nodes.Array) {
          this._emitLine("var " + i + ";");
          this._emitLine("if(runtime.isArray(" + arr + ")) {");
          this._emitLine("var " + len + " = " + arr + ".length;");
          this._emitLine("for(" + i + "=0; " + i + " < " + arr + ".length; " + i + "++) {");
          node.name.children.forEach(function(child, u) {
            var tid = _this10._tmpid();
            _this10._emitLine("var " + tid + " = " + arr + "[" + i + "][" + u + "];");
            _this10._emitLine('frame.set("' + child + '", ' + arr + "[" + i + "][" + u + "]);");
            frame.set(node.name.children[u].value, tid);
          });
          this._emitLoopBindings(node, arr, i, len);
          this._withScopedSyntax(function() {
            _this10.compile(node.body, frame);
          });
          this._emitLine("}");
          this._emitLine("} else {");
          var _node$name$children = node.name.children, key = _node$name$children[0], val = _node$name$children[1];
          var k = this._tmpid();
          var v = this._tmpid();
          frame.set(key.value, k);
          frame.set(val.value, v);
          this._emitLine(i + " = -1;");
          this._emitLine("var " + len + " = runtime.keys(" + arr + ").length;");
          this._emitLine("for(var " + k + " in " + arr + ") {");
          this._emitLine(i + "++;");
          this._emitLine("var " + v + " = " + arr + "[" + k + "];");
          this._emitLine('frame.set("' + key.value + '", ' + k + ");");
          this._emitLine('frame.set("' + val.value + '", ' + v + ");");
          this._emitLoopBindings(node, arr, i, len);
          this._withScopedSyntax(function() {
            _this10.compile(node.body, frame);
          });
          this._emitLine("}");
          this._emitLine("}");
        } else {
          var _v = this._tmpid();
          frame.set(node.name.value, _v);
          this._emitLine("var " + len + " = " + arr + ".length;");
          this._emitLine("for(var " + i + "=0; " + i + " < " + arr + ".length; " + i + "++) {");
          this._emitLine("var " + _v + " = " + arr + "[" + i + "];");
          this._emitLine('frame.set("' + node.name.value + '", ' + _v + ");");
          this._emitLoopBindings(node, arr, i, len);
          this._withScopedSyntax(function() {
            _this10.compile(node.body, frame);
          });
          this._emitLine("}");
        }
        this._emitLine("}");
        if (node.else_) {
          this._emitLine("if (!" + len + ") {");
          this.compile(node.else_, frame);
          this._emitLine("}");
        }
        this._emitLine("frame = frame.pop();");
      };
      _proto._compileAsyncLoop = function _compileAsyncLoop(node, frame, parallel) {
        var _this11 = this;
        var i = this._tmpid();
        var len = this._tmpid();
        var arr = this._tmpid();
        var asyncMethod = parallel ? "asyncAll" : "asyncEach";
        frame = frame.push();
        this._emitLine("frame = frame.push();");
        this._emit("var " + arr + " = runtime.fromIterator(");
        this._compileExpression(node.arr, frame);
        this._emitLine(");");
        if (node.name instanceof nodes.Array) {
          var arrayLen = node.name.children.length;
          this._emit("runtime." + asyncMethod + "(" + arr + ", " + arrayLen + ", function(");
          node.name.children.forEach(function(name) {
            _this11._emit(name.value + ",");
          });
          this._emit(i + "," + len + ",next) {");
          node.name.children.forEach(function(name) {
            var id2 = name.value;
            frame.set(id2, id2);
            _this11._emitLine('frame.set("' + id2 + '", ' + id2 + ");");
          });
        } else {
          var id = node.name.value;
          this._emitLine("runtime." + asyncMethod + "(" + arr + ", 1, function(" + id + ", " + i + ", " + len + ",next) {");
          this._emitLine('frame.set("' + id + '", ' + id + ");");
          frame.set(id, id);
        }
        this._emitLoopBindings(node, arr, i, len);
        this._withScopedSyntax(function() {
          var buf;
          if (parallel) {
            buf = _this11._pushBuffer();
          }
          _this11.compile(node.body, frame);
          _this11._emitLine("next(" + i + (buf ? "," + buf : "") + ");");
          if (parallel) {
            _this11._popBuffer();
          }
        });
        var output = this._tmpid();
        this._emitLine("}, " + this._makeCallback(output));
        this._addScopeLevel();
        if (parallel) {
          this._emitLine(this.buffer + " += " + output + ";");
        }
        if (node.else_) {
          this._emitLine("if (!" + arr + ".length) {");
          this.compile(node.else_, frame);
          this._emitLine("}");
        }
        this._emitLine("frame = frame.pop();");
      };
      _proto.compileAsyncEach = function compileAsyncEach(node, frame) {
        this._compileAsyncLoop(node, frame);
      };
      _proto.compileAsyncAll = function compileAsyncAll(node, frame) {
        this._compileAsyncLoop(node, frame, true);
      };
      _proto._compileMacro = function _compileMacro(node, frame) {
        var _this12 = this;
        var args = [];
        var kwargs = null;
        var funcId = "macro_" + this._tmpid();
        var keepFrame = frame !== void 0;
        node.args.children.forEach(function(arg, i) {
          if (i === node.args.children.length - 1 && arg instanceof nodes.Dict) {
            kwargs = arg;
          } else {
            _this12.assertType(arg, nodes.Symbol);
            args.push(arg);
          }
        });
        var realNames = [].concat(args.map(function(n) {
          return "l_" + n.value;
        }), ["kwargs"]);
        var argNames = args.map(function(n) {
          return '"' + n.value + '"';
        });
        var kwargNames = (kwargs && kwargs.children || []).map(function(n) {
          return '"' + n.key.value + '"';
        });
        var currFrame;
        if (keepFrame) {
          currFrame = frame.push(true);
        } else {
          currFrame = new Frame();
        }
        this._emitLines("var " + funcId + " = runtime.makeMacro(", "[" + argNames.join(", ") + "], ", "[" + kwargNames.join(", ") + "], ", "function (" + realNames.join(", ") + ") {", "var callerFrame = frame;", "frame = " + (keepFrame ? "frame.push(true);" : "new runtime.Frame();"), "kwargs = kwargs || {};", 'if (Object.prototype.hasOwnProperty.call(kwargs, "caller")) {', 'frame.set("caller", kwargs.caller); }');
        args.forEach(function(arg) {
          _this12._emitLine('frame.set("' + arg.value + '", l_' + arg.value + ");");
          currFrame.set(arg.value, "l_" + arg.value);
        });
        if (kwargs) {
          kwargs.children.forEach(function(pair) {
            var name = pair.key.value;
            _this12._emit('frame.set("' + name + '", ');
            _this12._emit('Object.prototype.hasOwnProperty.call(kwargs, "' + name + '")');
            _this12._emit(' ? kwargs["' + name + '"] : ');
            _this12._compileExpression(pair.value, currFrame);
            _this12._emit(");");
          });
        }
        var bufferId = this._pushBuffer();
        this._withScopedSyntax(function() {
          _this12.compile(node.body, currFrame);
        });
        this._emitLine("frame = " + (keepFrame ? "frame.pop();" : "callerFrame;"));
        this._emitLine("return new runtime.SafeString(" + bufferId + ");");
        this._emitLine("});");
        this._popBuffer();
        return funcId;
      };
      _proto.compileMacro = function compileMacro(node, frame) {
        var funcId = this._compileMacro(node);
        var name = node.name.value;
        frame.set(name, funcId);
        if (frame.parent) {
          this._emitLine('frame.set("' + name + '", ' + funcId + ");");
        } else {
          if (node.name.value.charAt(0) !== "_") {
            this._emitLine('context.addExport("' + name + '");');
          }
          this._emitLine('context.setVariable("' + name + '", ' + funcId + ");");
        }
      };
      _proto.compileCaller = function compileCaller(node, frame) {
        this._emit("(function (){");
        var funcId = this._compileMacro(node, frame);
        this._emit("return " + funcId + ";})()");
      };
      _proto._compileGetTemplate = function _compileGetTemplate(node, frame, eagerCompile, ignoreMissing) {
        var parentTemplateId = this._tmpid();
        var parentName = this._templateName();
        var cb = this._makeCallback(parentTemplateId);
        var eagerCompileArg = eagerCompile ? "true" : "false";
        var ignoreMissingArg = ignoreMissing ? "true" : "false";
        this._emit("env.getTemplate(");
        this._compileExpression(node.template, frame);
        this._emitLine(", " + eagerCompileArg + ", " + parentName + ", " + ignoreMissingArg + ", " + cb);
        return parentTemplateId;
      };
      _proto.compileImport = function compileImport(node, frame) {
        var target = node.target.value;
        var id = this._compileGetTemplate(node, frame, false, false);
        this._addScopeLevel();
        this._emitLine(id + ".getExported(" + (node.withContext ? "context.getVariables(), frame, " : "") + this._makeCallback(id));
        this._addScopeLevel();
        frame.set(target, id);
        if (frame.parent) {
          this._emitLine('frame.set("' + target + '", ' + id + ");");
        } else {
          this._emitLine('context.setVariable("' + target + '", ' + id + ");");
        }
      };
      _proto.compileFromImport = function compileFromImport(node, frame) {
        var _this13 = this;
        var importedId = this._compileGetTemplate(node, frame, false, false);
        this._addScopeLevel();
        this._emitLine(importedId + ".getExported(" + (node.withContext ? "context.getVariables(), frame, " : "") + this._makeCallback(importedId));
        this._addScopeLevel();
        node.names.children.forEach(function(nameNode) {
          var name;
          var alias;
          var id = _this13._tmpid();
          if (nameNode instanceof nodes.Pair) {
            name = nameNode.key.value;
            alias = nameNode.value.value;
          } else {
            name = nameNode.value;
            alias = name;
          }
          _this13._emitLine("if(Object.prototype.hasOwnProperty.call(" + importedId + ', "' + name + '")) {');
          _this13._emitLine("var " + id + " = " + importedId + "." + name + ";");
          _this13._emitLine("} else {");
          _this13._emitLine(`cb(new Error("cannot import '` + name + `'")); return;`);
          _this13._emitLine("}");
          frame.set(alias, id);
          if (frame.parent) {
            _this13._emitLine('frame.set("' + alias + '", ' + id + ");");
          } else {
            _this13._emitLine('context.setVariable("' + alias + '", ' + id + ");");
          }
        });
      };
      _proto.compileBlock = function compileBlock(node) {
        var id = this._tmpid();
        if (!this.inBlock) {
          this._emit('(parentTemplate ? function(e, c, f, r, cb) { cb(""); } : ');
        }
        this._emit('context.getBlock("' + node.name.value + '")');
        if (!this.inBlock) {
          this._emit(")");
        }
        this._emitLine("(env, context, frame, runtime, " + this._makeCallback(id));
        this._emitLine(this.buffer + " += " + id + ";");
        this._addScopeLevel();
      };
      _proto.compileSuper = function compileSuper(node, frame) {
        var name = node.blockName.value;
        var id = node.symbol.value;
        var cb = this._makeCallback(id);
        this._emitLine('context.getSuper(env, "' + name + '", b_' + name + ", frame, runtime, " + cb);
        this._emitLine(id + " = runtime.markSafe(" + id + ");");
        this._addScopeLevel();
        frame.set(id, id);
      };
      _proto.compileExtends = function compileExtends(node, frame) {
        var k = this._tmpid();
        var parentTemplateId = this._compileGetTemplate(node, frame, true, false);
        this._emitLine("parentTemplate = " + parentTemplateId);
        this._emitLine("for(var " + k + " in parentTemplate.blocks) {");
        this._emitLine("context.addBlock(" + k + ", parentTemplate.blocks[" + k + "]);");
        this._emitLine("}");
        this._addScopeLevel();
      };
      _proto.compileInclude = function compileInclude(node, frame) {
        this._emitLine("var tasks = [];");
        this._emitLine("tasks.push(");
        this._emitLine("function(callback) {");
        var id = this._compileGetTemplate(node, frame, false, node.ignoreMissing);
        this._emitLine("callback(null," + id + ");});");
        this._emitLine("});");
        var id2 = this._tmpid();
        this._emitLine("tasks.push(");
        this._emitLine("function(template, callback){");
        this._emitLine("template.render(context.getVariables(), frame, " + this._makeCallback(id2));
        this._emitLine("callback(null," + id2 + ");});");
        this._emitLine("});");
        this._emitLine("tasks.push(");
        this._emitLine("function(result, callback){");
        this._emitLine(this.buffer + " += result;");
        this._emitLine("callback(null);");
        this._emitLine("});");
        this._emitLine("env.waterfall(tasks, function(){");
        this._addScopeLevel();
      };
      _proto.compileTemplateData = function compileTemplateData(node, frame) {
        this.compileLiteral(node, frame);
      };
      _proto.compileCapture = function compileCapture(node, frame) {
        var _this14 = this;
        var buffer = this.buffer;
        this.buffer = "output";
        this._emitLine("(function() {");
        this._emitLine('var output = "";');
        this._withScopedSyntax(function() {
          _this14.compile(node.body, frame);
        });
        this._emitLine("return output;");
        this._emitLine("})()");
        this.buffer = buffer;
      };
      _proto.compileOutput = function compileOutput(node, frame) {
        var _this15 = this;
        var children = node.children;
        children.forEach(function(child) {
          if (child instanceof nodes.TemplateData) {
            if (child.value) {
              _this15._emit(_this15.buffer + " += ");
              _this15.compileLiteral(child, frame);
              _this15._emitLine(";");
            }
          } else {
            _this15._emit(_this15.buffer + " += runtime.suppressValue(");
            if (_this15.throwOnUndefined) {
              _this15._emit("runtime.ensureDefined(");
            }
            _this15.compile(child, frame);
            if (_this15.throwOnUndefined) {
              _this15._emit("," + node.lineno + "," + node.colno + ")");
            }
            _this15._emit(", env.opts.autoescape);\n");
          }
        });
      };
      _proto.compileRoot = function compileRoot(node, frame) {
        var _this16 = this;
        if (frame) {
          this.fail("compileRoot: root node can't have frame");
        }
        frame = new Frame();
        this._emitFuncBegin(node, "root");
        this._emitLine("var parentTemplate = null;");
        this._compileChildren(node, frame);
        this._emitLine("if(parentTemplate) {");
        this._emitLine("parentTemplate.rootRenderFunc(env, context, frame, runtime, cb);");
        this._emitLine("} else {");
        this._emitLine("cb(null, " + this.buffer + ");");
        this._emitLine("}");
        this._emitFuncEnd(true);
        this.inBlock = true;
        var blockNames = [];
        var blocks = node.findAll(nodes.Block);
        blocks.forEach(function(block, i) {
          var name = block.name.value;
          if (blockNames.indexOf(name) !== -1) {
            throw new Error('Block "' + name + '" defined more than once.');
          }
          blockNames.push(name);
          _this16._emitFuncBegin(block, "b_" + name);
          var tmpFrame = new Frame();
          _this16._emitLine("var frame = frame.push(true);");
          _this16.compile(block.body, tmpFrame);
          _this16._emitFuncEnd();
        });
        this._emitLine("return {");
        blocks.forEach(function(block, i) {
          var blockName = "b_" + block.name.value;
          _this16._emitLine(blockName + ": " + blockName + ",");
        });
        this._emitLine("root: root\n};");
      };
      _proto.compile = function compile(node, frame) {
        var _compile = this["compile" + node.typename];
        if (_compile) {
          _compile.call(this, node, frame);
        } else {
          this.fail("compile: Cannot compile node: " + node.typename, node.lineno, node.colno);
        }
      };
      _proto.getCode = function getCode() {
        return this.codebuf.join("");
      };
      return Compiler2;
    })(Obj);
    module.exports = {
      compile: function compile(src, asyncFilters, extensions, name, opts) {
        if (opts === void 0) {
          opts = {};
        }
        var c = new Compiler(name, opts.throwOnUndefined);
        var preprocessors = (extensions || []).map(function(ext) {
          return ext.preprocess;
        }).filter(function(f) {
          return !!f;
        });
        var processedSrc = preprocessors.reduce(function(s, processor) {
          return processor(s);
        }, src);
        c.compile(transformer.transform(parser.parse(processedSrc, extensions, opts), asyncFilters, name));
        return c.getCode();
      },
      Compiler
    };
  }
});

// node_modules/nunjucks/src/filters.js
var require_filters = __commonJS({
  "node_modules/nunjucks/src/filters.js"(exports, module) {
    "use strict";
    var lib = require_lib();
    var r = require_runtime();
    var _exports = module.exports = {};
    function normalize(value, defaultValue) {
      if (value === null || value === void 0 || value === false) {
        return defaultValue;
      }
      return value;
    }
    _exports.abs = Math.abs;
    function isNaN(num) {
      return num !== num;
    }
    function batch(arr, linecount, fillWith) {
      var i;
      var res = [];
      var tmp = [];
      for (i = 0; i < arr.length; i++) {
        if (i % linecount === 0 && tmp.length) {
          res.push(tmp);
          tmp = [];
        }
        tmp.push(arr[i]);
      }
      if (tmp.length) {
        if (fillWith) {
          for (i = tmp.length; i < linecount; i++) {
            tmp.push(fillWith);
          }
        }
        res.push(tmp);
      }
      return res;
    }
    _exports.batch = batch;
    function capitalize(str) {
      str = normalize(str, "");
      var ret = str.toLowerCase();
      return r.copySafeness(str, ret.charAt(0).toUpperCase() + ret.slice(1));
    }
    _exports.capitalize = capitalize;
    function center(str, width) {
      str = normalize(str, "");
      width = width || 80;
      if (str.length >= width) {
        return str;
      }
      var spaces = width - str.length;
      var pre = lib.repeat(" ", spaces / 2 - spaces % 2);
      var post = lib.repeat(" ", spaces / 2);
      return r.copySafeness(str, pre + str + post);
    }
    _exports.center = center;
    function default_(val, def, bool) {
      if (bool) {
        return val || def;
      } else {
        return val !== void 0 ? val : def;
      }
    }
    _exports["default"] = default_;
    function dictsort(val, caseSensitive, by) {
      if (!lib.isObject(val)) {
        throw new lib.TemplateError("dictsort filter: val must be an object");
      }
      var array = [];
      for (var k in val) {
        array.push([k, val[k]]);
      }
      var si;
      if (by === void 0 || by === "key") {
        si = 0;
      } else if (by === "value") {
        si = 1;
      } else {
        throw new lib.TemplateError("dictsort filter: You can only sort by either key or value");
      }
      array.sort(function(t1, t2) {
        var a = t1[si];
        var b = t2[si];
        if (!caseSensitive) {
          if (lib.isString(a)) {
            a = a.toUpperCase();
          }
          if (lib.isString(b)) {
            b = b.toUpperCase();
          }
        }
        return a > b ? 1 : a === b ? 0 : -1;
      });
      return array;
    }
    _exports.dictsort = dictsort;
    function dump(obj, spaces) {
      return JSON.stringify(obj, null, spaces);
    }
    _exports.dump = dump;
    function escape(str) {
      if (str instanceof r.SafeString) {
        return str;
      }
      str = str === null || str === void 0 ? "" : str;
      return r.markSafe(lib.escape(str.toString()));
    }
    _exports.escape = escape;
    function safe(str) {
      if (str instanceof r.SafeString) {
        return str;
      }
      str = str === null || str === void 0 ? "" : str;
      return r.markSafe(str.toString());
    }
    _exports.safe = safe;
    function first(arr) {
      return arr[0];
    }
    _exports.first = first;
    function forceescape(str) {
      str = str === null || str === void 0 ? "" : str;
      return r.markSafe(lib.escape(str.toString()));
    }
    _exports.forceescape = forceescape;
    function groupby(arr, attr) {
      return lib.groupBy(arr, attr, this.env.opts.throwOnUndefined);
    }
    _exports.groupby = groupby;
    function indent(str, width, indentfirst) {
      str = normalize(str, "");
      if (str === "") {
        return "";
      }
      width = width || 4;
      var lines = str.split("\n");
      var sp = lib.repeat(" ", width);
      var res = lines.map(function(l, i) {
        return i === 0 && !indentfirst ? l : "" + sp + l;
      }).join("\n");
      return r.copySafeness(str, res);
    }
    _exports.indent = indent;
    function join14(arr, del, attr) {
      del = del || "";
      if (attr) {
        arr = lib.map(arr, function(v) {
          return v[attr];
        });
      }
      return arr.join(del);
    }
    _exports.join = join14;
    function last(arr) {
      return arr[arr.length - 1];
    }
    _exports.last = last;
    function lengthFilter(val) {
      var value = normalize(val, "");
      if (value !== void 0) {
        if (typeof Map === "function" && value instanceof Map || typeof Set === "function" && value instanceof Set) {
          return value.size;
        }
        if (lib.isObject(value) && !(value instanceof r.SafeString)) {
          return lib.keys(value).length;
        }
        return value.length;
      }
      return 0;
    }
    _exports.length = lengthFilter;
    function list(val) {
      if (lib.isString(val)) {
        return val.split("");
      } else if (lib.isObject(val)) {
        return lib._entries(val || {}).map(function(_ref) {
          var key = _ref[0], value = _ref[1];
          return {
            key,
            value
          };
        });
      } else if (lib.isArray(val)) {
        return val;
      } else {
        throw new lib.TemplateError("list filter: type not iterable");
      }
    }
    _exports.list = list;
    function lower(str) {
      str = normalize(str, "");
      return str.toLowerCase();
    }
    _exports.lower = lower;
    function nl2br(str) {
      if (str === null || str === void 0) {
        return "";
      }
      return r.copySafeness(str, str.replace(/\r\n|\n/g, "<br />\n"));
    }
    _exports.nl2br = nl2br;
    function random(arr) {
      return arr[Math.floor(Math.random() * arr.length)];
    }
    _exports.random = random;
    function getSelectOrReject(expectedTestResult) {
      function filter(arr, testName, secondArg) {
        if (testName === void 0) {
          testName = "truthy";
        }
        var context = this;
        var test = context.env.getTest(testName);
        return lib.toArray(arr).filter(function examineTestResult(item) {
          return test.call(context, item, secondArg) === expectedTestResult;
        });
      }
      return filter;
    }
    _exports.reject = getSelectOrReject(false);
    function rejectattr(arr, attr) {
      return arr.filter(function(item) {
        return !item[attr];
      });
    }
    _exports.rejectattr = rejectattr;
    _exports.select = getSelectOrReject(true);
    function selectattr(arr, attr) {
      return arr.filter(function(item) {
        return !!item[attr];
      });
    }
    _exports.selectattr = selectattr;
    function replace(str, old, new_, maxCount) {
      var originalStr = str;
      if (old instanceof RegExp) {
        return str.replace(old, new_);
      }
      if (typeof maxCount === "undefined") {
        maxCount = -1;
      }
      var res = "";
      if (typeof old === "number") {
        old = "" + old;
      } else if (typeof old !== "string") {
        return str;
      }
      if (typeof str === "number") {
        str = "" + str;
      }
      if (typeof str !== "string" && !(str instanceof r.SafeString)) {
        return str;
      }
      if (old === "") {
        res = new_ + str.split("").join(new_) + new_;
        return r.copySafeness(str, res);
      }
      var nextIndex = str.indexOf(old);
      if (maxCount === 0 || nextIndex === -1) {
        return str;
      }
      var pos = 0;
      var count = 0;
      while (nextIndex > -1 && (maxCount === -1 || count < maxCount)) {
        res += str.substring(pos, nextIndex) + new_;
        pos = nextIndex + old.length;
        count++;
        nextIndex = str.indexOf(old, pos);
      }
      if (pos < str.length) {
        res += str.substring(pos);
      }
      return r.copySafeness(originalStr, res);
    }
    _exports.replace = replace;
    function reverse(val) {
      var arr;
      if (lib.isString(val)) {
        arr = list(val);
      } else {
        arr = lib.map(val, function(v) {
          return v;
        });
      }
      arr.reverse();
      if (lib.isString(val)) {
        return r.copySafeness(val, arr.join(""));
      }
      return arr;
    }
    _exports.reverse = reverse;
    function round(val, precision, method) {
      precision = precision || 0;
      var factor = Math.pow(10, precision);
      var rounder;
      if (method === "ceil") {
        rounder = Math.ceil;
      } else if (method === "floor") {
        rounder = Math.floor;
      } else {
        rounder = Math.round;
      }
      return rounder(val * factor) / factor;
    }
    _exports.round = round;
    function slice(arr, slices, fillWith) {
      var sliceLength = Math.floor(arr.length / slices);
      var extra = arr.length % slices;
      var res = [];
      var offset = 0;
      for (var i = 0; i < slices; i++) {
        var start = offset + i * sliceLength;
        if (i < extra) {
          offset++;
        }
        var end = offset + (i + 1) * sliceLength;
        var currSlice = arr.slice(start, end);
        if (fillWith && i >= extra) {
          currSlice.push(fillWith);
        }
        res.push(currSlice);
      }
      return res;
    }
    _exports.slice = slice;
    function sum(arr, attr, start) {
      if (start === void 0) {
        start = 0;
      }
      if (attr) {
        arr = lib.map(arr, function(v) {
          return v[attr];
        });
      }
      return start + arr.reduce(function(a, b) {
        return a + b;
      }, 0);
    }
    _exports.sum = sum;
    _exports.sort = r.makeMacro(["value", "reverse", "case_sensitive", "attribute"], [], function sortFilter(arr, reversed, caseSens, attr) {
      var _this = this;
      var array = lib.map(arr, function(v) {
        return v;
      });
      var getAttribute = lib.getAttrGetter(attr);
      array.sort(function(a, b) {
        var x = attr ? getAttribute(a) : a;
        var y = attr ? getAttribute(b) : b;
        if (_this.env.opts.throwOnUndefined && attr && (x === void 0 || y === void 0)) {
          throw new TypeError('sort: attribute "' + attr + '" resolved to undefined');
        }
        if (!caseSens && lib.isString(x) && lib.isString(y)) {
          x = x.toLowerCase();
          y = y.toLowerCase();
        }
        if (x < y) {
          return reversed ? 1 : -1;
        } else if (x > y) {
          return reversed ? -1 : 1;
        } else {
          return 0;
        }
      });
      return array;
    });
    function string(obj) {
      return r.copySafeness(obj, obj);
    }
    _exports.string = string;
    function striptags(input, preserveLinebreaks) {
      input = normalize(input, "");
      var tags = /<\/?([a-z][a-z0-9]*)\b[^>]*>|<!--[\s\S]*?-->/gi;
      var trimmedInput = trim(input.replace(tags, ""));
      var res = "";
      if (preserveLinebreaks) {
        res = trimmedInput.replace(/^ +| +$/gm, "").replace(/ +/g, " ").replace(/(\r\n)/g, "\n").replace(/\n\n\n+/g, "\n\n");
      } else {
        res = trimmedInput.replace(/\s+/gi, " ");
      }
      return r.copySafeness(input, res);
    }
    _exports.striptags = striptags;
    function title(str) {
      str = normalize(str, "");
      var words = str.split(" ").map(function(word) {
        return capitalize(word);
      });
      return r.copySafeness(str, words.join(" "));
    }
    _exports.title = title;
    function trim(str) {
      return r.copySafeness(str, str.replace(/^\s*|\s*$/g, ""));
    }
    _exports.trim = trim;
    function truncate(input, length, killwords, end) {
      var orig = input;
      input = normalize(input, "");
      length = length || 255;
      if (input.length <= length) {
        return input;
      }
      if (killwords) {
        input = input.substring(0, length);
      } else {
        var idx = input.lastIndexOf(" ", length);
        if (idx === -1) {
          idx = length;
        }
        input = input.substring(0, idx);
      }
      input += end !== void 0 && end !== null ? end : "...";
      return r.copySafeness(orig, input);
    }
    _exports.truncate = truncate;
    function upper(str) {
      str = normalize(str, "");
      return str.toUpperCase();
    }
    _exports.upper = upper;
    function urlencode(obj) {
      var enc = encodeURIComponent;
      if (lib.isString(obj)) {
        return enc(obj);
      } else {
        var keyvals = lib.isArray(obj) ? obj : lib._entries(obj);
        return keyvals.map(function(_ref2) {
          var k = _ref2[0], v = _ref2[1];
          return enc(k) + "=" + enc(v);
        }).join("&");
      }
    }
    _exports.urlencode = urlencode;
    var puncRe = /^(?:\(|<|&lt;)?(.*?)(?:\.|,|\)|\n|&gt;)?$/;
    var emailRe = /^[\w.!#$%&'*+\-\/=?\^`{|}~]+@[a-z\d\-]+(\.[a-z\d\-]+)+$/i;
    var httpHttpsRe = /^https?:\/\/.*$/;
    var wwwRe = /^www\./;
    var tldRe = /\.(?:org|net|com)(?:\:|\/|$)/;
    function urlize(str, length, nofollow) {
      if (isNaN(length)) {
        length = Infinity;
      }
      var noFollowAttr = nofollow === true ? ' rel="nofollow"' : "";
      var words = str.split(/(\s+)/).filter(function(word) {
        return word && word.length;
      }).map(function(word) {
        var matches = word.match(puncRe);
        var possibleUrl = matches ? matches[1] : word;
        var shortUrl = possibleUrl.substr(0, length);
        if (httpHttpsRe.test(possibleUrl)) {
          return '<a href="' + possibleUrl + '"' + noFollowAttr + ">" + shortUrl + "</a>";
        }
        if (wwwRe.test(possibleUrl)) {
          return '<a href="http://' + possibleUrl + '"' + noFollowAttr + ">" + shortUrl + "</a>";
        }
        if (emailRe.test(possibleUrl)) {
          return '<a href="mailto:' + possibleUrl + '">' + possibleUrl + "</a>";
        }
        if (tldRe.test(possibleUrl)) {
          return '<a href="http://' + possibleUrl + '"' + noFollowAttr + ">" + shortUrl + "</a>";
        }
        return word;
      });
      return words.join("");
    }
    _exports.urlize = urlize;
    function wordcount(str) {
      str = normalize(str, "");
      var words = str ? str.match(/\w+/g) : null;
      return words ? words.length : null;
    }
    _exports.wordcount = wordcount;
    function float(val, def) {
      var res = parseFloat(val);
      return isNaN(res) ? def : res;
    }
    _exports.float = float;
    var intFilter = r.makeMacro(["value", "default", "base"], [], function doInt(value, defaultValue, base) {
      if (base === void 0) {
        base = 10;
      }
      var res = parseInt(value, base);
      return isNaN(res) ? defaultValue : res;
    });
    _exports.int = intFilter;
    _exports.d = _exports.default;
    _exports.e = _exports.escape;
  }
});

// node_modules/nunjucks/src/loader.js
var require_loader = __commonJS({
  "node_modules/nunjucks/src/loader.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var path = __require("path");
    var _require = require_object();
    var EmitterObj = _require.EmitterObj;
    module.exports = /* @__PURE__ */ (function(_EmitterObj) {
      _inheritsLoose(Loader, _EmitterObj);
      function Loader() {
        return _EmitterObj.apply(this, arguments) || this;
      }
      var _proto = Loader.prototype;
      _proto.resolve = function resolve(from, to) {
        return path.resolve(path.dirname(from), to);
      };
      _proto.isRelative = function isRelative(filename) {
        return filename.indexOf("./") === 0 || filename.indexOf("../") === 0;
      };
      return Loader;
    })(EmitterObj);
  }
});

// node_modules/nunjucks/src/precompiled-loader.js
var require_precompiled_loader = __commonJS({
  "node_modules/nunjucks/src/precompiled-loader.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var Loader = require_loader();
    var PrecompiledLoader = /* @__PURE__ */ (function(_Loader) {
      _inheritsLoose(PrecompiledLoader2, _Loader);
      function PrecompiledLoader2(compiledTemplates) {
        var _this;
        _this = _Loader.call(this) || this;
        _this.precompiled = compiledTemplates || {};
        return _this;
      }
      var _proto = PrecompiledLoader2.prototype;
      _proto.getSource = function getSource(name) {
        if (this.precompiled[name]) {
          return {
            src: {
              type: "code",
              obj: this.precompiled[name]
            },
            path: name
          };
        }
        return null;
      };
      return PrecompiledLoader2;
    })(Loader);
    module.exports = {
      PrecompiledLoader
    };
  }
});

// node_modules/nunjucks/src/node-loaders.js
var require_node_loaders = __commonJS({
  "node_modules/nunjucks/src/node-loaders.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var fs = __require("fs");
    var path = __require("path");
    var Loader = require_loader();
    var _require = require_precompiled_loader();
    var PrecompiledLoader = _require.PrecompiledLoader;
    var chokidar;
    var FileSystemLoader = /* @__PURE__ */ (function(_Loader) {
      _inheritsLoose(FileSystemLoader2, _Loader);
      function FileSystemLoader2(searchPaths, opts) {
        var _this;
        _this = _Loader.call(this) || this;
        if (typeof opts === "boolean") {
          console.log("[nunjucks] Warning: you passed a boolean as the second argument to FileSystemLoader, but it now takes an options object. See http://mozilla.github.io/nunjucks/api.html#filesystemloader");
        }
        opts = opts || {};
        _this.pathsToNames = {};
        _this.noCache = !!opts.noCache;
        if (searchPaths) {
          searchPaths = Array.isArray(searchPaths) ? searchPaths : [searchPaths];
          _this.searchPaths = searchPaths.map(path.normalize);
        } else {
          _this.searchPaths = ["."];
        }
        if (opts.watch) {
          try {
            chokidar = __require("chokidar");
          } catch (e) {
            throw new Error("watch requires chokidar to be installed");
          }
          var paths = _this.searchPaths.filter(fs.existsSync);
          var watcher = chokidar.watch(paths);
          watcher.on("all", function(event, fullname) {
            fullname = path.resolve(fullname);
            if (event === "change" && fullname in _this.pathsToNames) {
              _this.emit("update", _this.pathsToNames[fullname], fullname);
            }
          });
          watcher.on("error", function(error) {
            console.log("Watcher error: " + error);
          });
        }
        return _this;
      }
      var _proto = FileSystemLoader2.prototype;
      _proto.getSource = function getSource(name) {
        var fullpath = null;
        var paths = this.searchPaths;
        for (var i = 0; i < paths.length; i++) {
          var basePath = path.resolve(paths[i]);
          var p = path.resolve(paths[i], name);
          if (p.indexOf(basePath) === 0 && fs.existsSync(p)) {
            fullpath = p;
            break;
          }
        }
        if (!fullpath) {
          return null;
        }
        this.pathsToNames[fullpath] = name;
        var source = {
          src: fs.readFileSync(fullpath, "utf-8"),
          path: fullpath,
          noCache: this.noCache
        };
        this.emit("load", name, source);
        return source;
      };
      return FileSystemLoader2;
    })(Loader);
    var NodeResolveLoader = /* @__PURE__ */ (function(_Loader2) {
      _inheritsLoose(NodeResolveLoader2, _Loader2);
      function NodeResolveLoader2(opts) {
        var _this2;
        _this2 = _Loader2.call(this) || this;
        opts = opts || {};
        _this2.pathsToNames = {};
        _this2.noCache = !!opts.noCache;
        if (opts.watch) {
          try {
            chokidar = __require("chokidar");
          } catch (e) {
            throw new Error("watch requires chokidar to be installed");
          }
          _this2.watcher = chokidar.watch();
          _this2.watcher.on("change", function(fullname) {
            _this2.emit("update", _this2.pathsToNames[fullname], fullname);
          });
          _this2.watcher.on("error", function(error) {
            console.log("Watcher error: " + error);
          });
          _this2.on("load", function(name, source) {
            _this2.watcher.add(source.path);
          });
        }
        return _this2;
      }
      var _proto2 = NodeResolveLoader2.prototype;
      _proto2.getSource = function getSource(name) {
        if (/^\.?\.?(\/|\\)/.test(name)) {
          return null;
        }
        if (/^[A-Z]:/.test(name)) {
          return null;
        }
        var fullpath;
        try {
          fullpath = __require.resolve(name);
        } catch (e) {
          return null;
        }
        this.pathsToNames[fullpath] = name;
        var source = {
          src: fs.readFileSync(fullpath, "utf-8"),
          path: fullpath,
          noCache: this.noCache
        };
        this.emit("load", name, source);
        return source;
      };
      return NodeResolveLoader2;
    })(Loader);
    module.exports = {
      FileSystemLoader,
      PrecompiledLoader,
      NodeResolveLoader
    };
  }
});

// node_modules/nunjucks/src/loaders.js
var require_loaders = __commonJS({
  "node_modules/nunjucks/src/loaders.js"(exports, module) {
    "use strict";
    module.exports = require_node_loaders();
  }
});

// node_modules/nunjucks/src/tests.js
var require_tests = __commonJS({
  "node_modules/nunjucks/src/tests.js"(exports) {
    "use strict";
    var SafeString = require_runtime().SafeString;
    function callable(value) {
      return typeof value === "function";
    }
    exports.callable = callable;
    function defined(value) {
      return value !== void 0;
    }
    exports.defined = defined;
    function divisibleby(one, two) {
      return one % two === 0;
    }
    exports.divisibleby = divisibleby;
    function escaped(value) {
      return value instanceof SafeString;
    }
    exports.escaped = escaped;
    function equalto(one, two) {
      return one === two;
    }
    exports.equalto = equalto;
    exports.eq = exports.equalto;
    exports.sameas = exports.equalto;
    function even(value) {
      return value % 2 === 0;
    }
    exports.even = even;
    function falsy(value) {
      return !value;
    }
    exports.falsy = falsy;
    function ge(one, two) {
      return one >= two;
    }
    exports.ge = ge;
    function greaterthan(one, two) {
      return one > two;
    }
    exports.greaterthan = greaterthan;
    exports.gt = exports.greaterthan;
    function le(one, two) {
      return one <= two;
    }
    exports.le = le;
    function lessthan(one, two) {
      return one < two;
    }
    exports.lessthan = lessthan;
    exports.lt = exports.lessthan;
    function lower(value) {
      return value.toLowerCase() === value;
    }
    exports.lower = lower;
    function ne(one, two) {
      return one !== two;
    }
    exports.ne = ne;
    function nullTest(value) {
      return value === null;
    }
    exports.null = nullTest;
    function number(value) {
      return typeof value === "number";
    }
    exports.number = number;
    function odd(value) {
      return value % 2 === 1;
    }
    exports.odd = odd;
    function string(value) {
      return typeof value === "string";
    }
    exports.string = string;
    function truthy(value) {
      return !!value;
    }
    exports.truthy = truthy;
    function undefinedTest(value) {
      return value === void 0;
    }
    exports.undefined = undefinedTest;
    function upper(value) {
      return value.toUpperCase() === value;
    }
    exports.upper = upper;
    function iterable(value) {
      if (typeof Symbol !== "undefined") {
        return !!value[Symbol.iterator];
      } else {
        return Array.isArray(value) || typeof value === "string";
      }
    }
    exports.iterable = iterable;
    function mapping(value) {
      var bool = value !== null && value !== void 0 && typeof value === "object" && !Array.isArray(value);
      if (Set) {
        return bool && !(value instanceof Set);
      } else {
        return bool;
      }
    }
    exports.mapping = mapping;
  }
});

// node_modules/nunjucks/src/globals.js
var require_globals = __commonJS({
  "node_modules/nunjucks/src/globals.js"(exports, module) {
    "use strict";
    function _cycler(items) {
      var index = -1;
      return {
        current: null,
        reset: function reset() {
          index = -1;
          this.current = null;
        },
        next: function next() {
          index++;
          if (index >= items.length) {
            index = 0;
          }
          this.current = items[index];
          return this.current;
        }
      };
    }
    function _joiner(sep4) {
      sep4 = sep4 || ",";
      var first = true;
      return function() {
        var val = first ? "" : sep4;
        first = false;
        return val;
      };
    }
    function globals() {
      return {
        range: function range(start, stop, step) {
          if (typeof stop === "undefined") {
            stop = start;
            start = 0;
            step = 1;
          } else if (!step) {
            step = 1;
          }
          var arr = [];
          if (step > 0) {
            for (var i = start; i < stop; i += step) {
              arr.push(i);
            }
          } else {
            for (var _i = start; _i > stop; _i += step) {
              arr.push(_i);
            }
          }
          return arr;
        },
        cycler: function cycler() {
          return _cycler(Array.prototype.slice.call(arguments));
        },
        joiner: function joiner(sep4) {
          return _joiner(sep4);
        }
      };
    }
    module.exports = globals;
  }
});

// node_modules/nunjucks/src/express-app.js
var require_express_app = __commonJS({
  "node_modules/nunjucks/src/express-app.js"(exports, module) {
    "use strict";
    var path = __require("path");
    module.exports = function express(env, app) {
      function NunjucksView(name, opts) {
        this.name = name;
        this.path = name;
        this.defaultEngine = opts.defaultEngine;
        this.ext = path.extname(name);
        if (!this.ext && !this.defaultEngine) {
          throw new Error("No default engine was specified and no extension was provided.");
        }
        if (!this.ext) {
          this.name += this.ext = (this.defaultEngine[0] !== "." ? "." : "") + this.defaultEngine;
        }
      }
      NunjucksView.prototype.render = function render(opts, cb) {
        env.render(this.name, opts, cb);
      };
      app.set("view", NunjucksView);
      app.set("nunjucksEnv", env);
      return env;
    };
  }
});

// node_modules/nunjucks/src/environment.js
var require_environment = __commonJS({
  "node_modules/nunjucks/src/environment.js"(exports, module) {
    "use strict";
    function _inheritsLoose(subClass, superClass) {
      subClass.prototype = Object.create(superClass.prototype);
      subClass.prototype.constructor = subClass;
      _setPrototypeOf(subClass, superClass);
    }
    function _setPrototypeOf(o, p) {
      _setPrototypeOf = Object.setPrototypeOf ? Object.setPrototypeOf.bind() : function _setPrototypeOf2(o2, p2) {
        o2.__proto__ = p2;
        return o2;
      };
      return _setPrototypeOf(o, p);
    }
    var asap = require_asap();
    var _waterfall = require_a_sync_waterfall();
    var lib = require_lib();
    var compiler = require_compiler();
    var filters = require_filters();
    var _require = require_loaders();
    var FileSystemLoader = _require.FileSystemLoader;
    var WebLoader = _require.WebLoader;
    var PrecompiledLoader = _require.PrecompiledLoader;
    var tests = require_tests();
    var globals = require_globals();
    var _require2 = require_object();
    var Obj = _require2.Obj;
    var EmitterObj = _require2.EmitterObj;
    var globalRuntime = require_runtime();
    var handleError = globalRuntime.handleError;
    var Frame = globalRuntime.Frame;
    var expressApp = require_express_app();
    function callbackAsap(cb, err, res) {
      asap(function() {
        cb(err, res);
      });
    }
    var noopTmplSrc = {
      type: "code",
      obj: {
        root: function root(env, context, frame, runtime, cb) {
          try {
            cb(null, "");
          } catch (e) {
            cb(handleError(e, null, null));
          }
        }
      }
    };
    var Environment = /* @__PURE__ */ (function(_EmitterObj) {
      _inheritsLoose(Environment2, _EmitterObj);
      function Environment2() {
        return _EmitterObj.apply(this, arguments) || this;
      }
      var _proto = Environment2.prototype;
      _proto.init = function init(loaders, opts) {
        var _this = this;
        opts = this.opts = opts || {};
        this.opts.dev = !!opts.dev;
        this.opts.autoescape = opts.autoescape != null ? opts.autoescape : true;
        this.opts.throwOnUndefined = !!opts.throwOnUndefined;
        this.opts.trimBlocks = !!opts.trimBlocks;
        this.opts.lstripBlocks = !!opts.lstripBlocks;
        this.loaders = [];
        if (!loaders) {
          if (FileSystemLoader) {
            this.loaders = [new FileSystemLoader("views")];
          } else if (WebLoader) {
            this.loaders = [new WebLoader("/views")];
          }
        } else {
          this.loaders = lib.isArray(loaders) ? loaders : [loaders];
        }
        if (typeof window !== "undefined" && window.nunjucksPrecompiled) {
          this.loaders.unshift(new PrecompiledLoader(window.nunjucksPrecompiled));
        }
        this._initLoaders();
        this.globals = globals();
        this.filters = {};
        this.tests = {};
        this.asyncFilters = [];
        this.extensions = {};
        this.extensionsList = [];
        lib._entries(filters).forEach(function(_ref) {
          var name = _ref[0], filter = _ref[1];
          return _this.addFilter(name, filter);
        });
        lib._entries(tests).forEach(function(_ref2) {
          var name = _ref2[0], test = _ref2[1];
          return _this.addTest(name, test);
        });
      };
      _proto._initLoaders = function _initLoaders() {
        var _this2 = this;
        this.loaders.forEach(function(loader) {
          loader.cache = {};
          if (typeof loader.on === "function") {
            loader.on("update", function(name, fullname) {
              loader.cache[name] = null;
              _this2.emit("update", name, fullname, loader);
            });
            loader.on("load", function(name, source) {
              _this2.emit("load", name, source, loader);
            });
          }
        });
      };
      _proto.invalidateCache = function invalidateCache() {
        this.loaders.forEach(function(loader) {
          loader.cache = {};
        });
      };
      _proto.addExtension = function addExtension(name, extension) {
        extension.__name = name;
        this.extensions[name] = extension;
        this.extensionsList.push(extension);
        return this;
      };
      _proto.removeExtension = function removeExtension(name) {
        var extension = this.getExtension(name);
        if (!extension) {
          return;
        }
        this.extensionsList = lib.without(this.extensionsList, extension);
        delete this.extensions[name];
      };
      _proto.getExtension = function getExtension(name) {
        return this.extensions[name];
      };
      _proto.hasExtension = function hasExtension(name) {
        return !!this.extensions[name];
      };
      _proto.addGlobal = function addGlobal(name, value) {
        this.globals[name] = value;
        return this;
      };
      _proto.getGlobal = function getGlobal(name) {
        if (typeof this.globals[name] === "undefined") {
          throw new Error("global not found: " + name);
        }
        return this.globals[name];
      };
      _proto.addFilter = function addFilter(name, func, async) {
        var wrapped = func;
        if (async) {
          this.asyncFilters.push(name);
        }
        this.filters[name] = wrapped;
        return this;
      };
      _proto.getFilter = function getFilter(name) {
        if (!this.filters[name]) {
          throw new Error("filter not found: " + name);
        }
        return this.filters[name];
      };
      _proto.addTest = function addTest(name, func) {
        this.tests[name] = func;
        return this;
      };
      _proto.getTest = function getTest(name) {
        if (!this.tests[name]) {
          throw new Error("test not found: " + name);
        }
        return this.tests[name];
      };
      _proto.resolveTemplate = function resolveTemplate(loader, parentName, filename) {
        var isRelative = loader.isRelative && parentName ? loader.isRelative(filename) : false;
        return isRelative && loader.resolve ? loader.resolve(parentName, filename) : filename;
      };
      _proto.getTemplate = function getTemplate(name, eagerCompile, parentName, ignoreMissing, cb) {
        var _this3 = this;
        var that = this;
        var tmpl = null;
        if (name && name.raw) {
          name = name.raw;
        }
        if (lib.isFunction(parentName)) {
          cb = parentName;
          parentName = null;
          eagerCompile = eagerCompile || false;
        }
        if (lib.isFunction(eagerCompile)) {
          cb = eagerCompile;
          eagerCompile = false;
        }
        if (name instanceof Template) {
          tmpl = name;
        } else if (typeof name !== "string") {
          throw new Error("template names must be a string: " + name);
        } else {
          for (var i = 0; i < this.loaders.length; i++) {
            var loader = this.loaders[i];
            tmpl = loader.cache[this.resolveTemplate(loader, parentName, name)];
            if (tmpl) {
              break;
            }
          }
        }
        if (tmpl) {
          if (eagerCompile) {
            tmpl.compile();
          }
          if (cb) {
            cb(null, tmpl);
            return void 0;
          } else {
            return tmpl;
          }
        }
        var syncResult;
        var createTemplate = function createTemplate2(err, info) {
          if (!info && !err && !ignoreMissing) {
            err = new Error("template not found: " + name);
          }
          if (err) {
            if (cb) {
              cb(err);
              return;
            } else {
              throw err;
            }
          }
          var newTmpl;
          if (!info) {
            newTmpl = new Template(noopTmplSrc, _this3, "", eagerCompile);
          } else {
            newTmpl = new Template(info.src, _this3, info.path, eagerCompile);
            if (!info.noCache) {
              info.loader.cache[name] = newTmpl;
            }
          }
          if (cb) {
            cb(null, newTmpl);
          } else {
            syncResult = newTmpl;
          }
        };
        lib.asyncIter(this.loaders, function(loader2, i2, next, done) {
          function handle(err, src) {
            if (err) {
              done(err);
            } else if (src) {
              src.loader = loader2;
              done(null, src);
            } else {
              next();
            }
          }
          name = that.resolveTemplate(loader2, parentName, name);
          if (loader2.async) {
            loader2.getSource(name, handle);
          } else {
            handle(null, loader2.getSource(name));
          }
        }, createTemplate);
        return syncResult;
      };
      _proto.express = function express(app) {
        return expressApp(this, app);
      };
      _proto.render = function render(name, ctx, cb) {
        if (lib.isFunction(ctx)) {
          cb = ctx;
          ctx = null;
        }
        var syncResult = null;
        this.getTemplate(name, function(err, tmpl) {
          if (err && cb) {
            callbackAsap(cb, err);
          } else if (err) {
            throw err;
          } else {
            syncResult = tmpl.render(ctx, cb);
          }
        });
        return syncResult;
      };
      _proto.renderString = function renderString(src, ctx, opts, cb) {
        if (lib.isFunction(opts)) {
          cb = opts;
          opts = {};
        }
        opts = opts || {};
        var tmpl = new Template(src, this, opts.path);
        return tmpl.render(ctx, cb);
      };
      _proto.waterfall = function waterfall(tasks, callback, forceAsync) {
        return _waterfall(tasks, callback, forceAsync);
      };
      return Environment2;
    })(EmitterObj);
    var Context = /* @__PURE__ */ (function(_Obj) {
      _inheritsLoose(Context2, _Obj);
      function Context2() {
        return _Obj.apply(this, arguments) || this;
      }
      var _proto2 = Context2.prototype;
      _proto2.init = function init(ctx, blocks, env) {
        var _this4 = this;
        this.env = env || new Environment();
        this.ctx = lib.extend({}, ctx);
        this.blocks = {};
        this.exported = [];
        lib.keys(blocks).forEach(function(name) {
          _this4.addBlock(name, blocks[name]);
        });
      };
      _proto2.lookup = function lookup(name) {
        if (name in this.env.globals && !(name in this.ctx)) {
          return this.env.globals[name];
        } else {
          return this.ctx[name];
        }
      };
      _proto2.setVariable = function setVariable(name, val) {
        this.ctx[name] = val;
      };
      _proto2.getVariables = function getVariables() {
        return this.ctx;
      };
      _proto2.addBlock = function addBlock(name, block) {
        this.blocks[name] = this.blocks[name] || [];
        this.blocks[name].push(block);
        return this;
      };
      _proto2.getBlock = function getBlock(name) {
        if (!this.blocks[name]) {
          throw new Error('unknown block "' + name + '"');
        }
        return this.blocks[name][0];
      };
      _proto2.getSuper = function getSuper(env, name, block, frame, runtime, cb) {
        var idx = lib.indexOf(this.blocks[name] || [], block);
        var blk = this.blocks[name][idx + 1];
        var context = this;
        if (idx === -1 || !blk) {
          throw new Error('no super block available for "' + name + '"');
        }
        blk(env, context, frame, runtime, cb);
      };
      _proto2.addExport = function addExport(name) {
        this.exported.push(name);
      };
      _proto2.getExported = function getExported() {
        var _this5 = this;
        var exported = {};
        this.exported.forEach(function(name) {
          exported[name] = _this5.ctx[name];
        });
        return exported;
      };
      return Context2;
    })(Obj);
    var Template = /* @__PURE__ */ (function(_Obj2) {
      _inheritsLoose(Template2, _Obj2);
      function Template2() {
        return _Obj2.apply(this, arguments) || this;
      }
      var _proto3 = Template2.prototype;
      _proto3.init = function init(src, env, path, eagerCompile) {
        this.env = env || new Environment();
        if (lib.isObject(src)) {
          switch (src.type) {
            case "code":
              this.tmplProps = src.obj;
              break;
            case "string":
              this.tmplStr = src.obj;
              break;
            default:
              throw new Error("Unexpected template object type " + src.type + "; expected 'code', or 'string'");
          }
        } else if (lib.isString(src)) {
          this.tmplStr = src;
        } else {
          throw new Error("src must be a string or an object describing the source");
        }
        this.path = path;
        if (eagerCompile) {
          try {
            this._compile();
          } catch (err) {
            throw lib._prettifyError(this.path, this.env.opts.dev, err);
          }
        } else {
          this.compiled = false;
        }
      };
      _proto3.render = function render(ctx, parentFrame, cb) {
        var _this6 = this;
        if (typeof ctx === "function") {
          cb = ctx;
          ctx = {};
        } else if (typeof parentFrame === "function") {
          cb = parentFrame;
          parentFrame = null;
        }
        var forceAsync = !parentFrame;
        try {
          this.compile();
        } catch (e) {
          var err = lib._prettifyError(this.path, this.env.opts.dev, e);
          if (cb) {
            return callbackAsap(cb, err);
          } else {
            throw err;
          }
        }
        var context = new Context(ctx || {}, this.blocks, this.env);
        var frame = parentFrame ? parentFrame.push(true) : new Frame();
        frame.topLevel = true;
        var syncResult = null;
        var didError = false;
        this.rootRenderFunc(this.env, context, frame, globalRuntime, function(err2, res) {
          if (didError && cb && typeof res !== "undefined") {
            return;
          }
          if (err2) {
            err2 = lib._prettifyError(_this6.path, _this6.env.opts.dev, err2);
            didError = true;
          }
          if (cb) {
            if (forceAsync) {
              callbackAsap(cb, err2, res);
            } else {
              cb(err2, res);
            }
          } else {
            if (err2) {
              throw err2;
            }
            syncResult = res;
          }
        });
        return syncResult;
      };
      _proto3.getExported = function getExported(ctx, parentFrame, cb) {
        if (typeof ctx === "function") {
          cb = ctx;
          ctx = {};
        }
        if (typeof parentFrame === "function") {
          cb = parentFrame;
          parentFrame = null;
        }
        try {
          this.compile();
        } catch (e) {
          if (cb) {
            return cb(e);
          } else {
            throw e;
          }
        }
        var frame = parentFrame ? parentFrame.push() : new Frame();
        frame.topLevel = true;
        var context = new Context(ctx || {}, this.blocks, this.env);
        this.rootRenderFunc(this.env, context, frame, globalRuntime, function(err) {
          if (err) {
            cb(err, null);
          } else {
            cb(null, context.getExported());
          }
        });
      };
      _proto3.compile = function compile() {
        if (!this.compiled) {
          this._compile();
        }
      };
      _proto3._compile = function _compile() {
        var props;
        if (this.tmplProps) {
          props = this.tmplProps;
        } else {
          var source = compiler.compile(this.tmplStr, this.env.asyncFilters, this.env.extensionsList, this.path, this.env.opts);
          var func = new Function(source);
          props = func();
        }
        this.blocks = this._getBlocks(props);
        this.rootRenderFunc = props.root;
        this.compiled = true;
      };
      _proto3._getBlocks = function _getBlocks(props) {
        var blocks = {};
        lib.keys(props).forEach(function(k) {
          if (k.slice(0, 2) === "b_") {
            blocks[k.slice(2)] = props[k];
          }
        });
        return blocks;
      };
      return Template2;
    })(Obj);
    module.exports = {
      Environment,
      Template
    };
  }
});

// node_modules/nunjucks/src/precompile-global.js
var require_precompile_global = __commonJS({
  "node_modules/nunjucks/src/precompile-global.js"(exports, module) {
    "use strict";
    function precompileGlobal(templates, opts) {
      var out = "";
      opts = opts || {};
      for (var i = 0; i < templates.length; i++) {
        var name = JSON.stringify(templates[i].name);
        var template = templates[i].template;
        out += "(function() {(window.nunjucksPrecompiled = window.nunjucksPrecompiled || {})[" + name + "] = (function() {\n" + template + "\n})();\n";
        if (opts.asFunction) {
          out += "return function(ctx, cb) { return nunjucks.render(" + name + ", ctx, cb); }\n";
        }
        out += "})();\n";
      }
      return out;
    }
    module.exports = precompileGlobal;
  }
});

// node_modules/nunjucks/src/precompile.js
var require_precompile = __commonJS({
  "node_modules/nunjucks/src/precompile.js"(exports, module) {
    "use strict";
    var fs = __require("fs");
    var path = __require("path");
    var _require = require_lib();
    var _prettifyError = _require._prettifyError;
    var compiler = require_compiler();
    var _require2 = require_environment();
    var Environment = _require2.Environment;
    var precompileGlobal = require_precompile_global();
    function match(filename, patterns) {
      if (!Array.isArray(patterns)) {
        return false;
      }
      return patterns.some(function(pattern) {
        return filename.match(pattern);
      });
    }
    function precompileString(str, opts) {
      opts = opts || {};
      opts.isString = true;
      var env = opts.env || new Environment([]);
      var wrapper = opts.wrapper || precompileGlobal;
      if (!opts.name) {
        throw new Error('the "name" option is required when compiling a string');
      }
      return wrapper([_precompile(str, opts.name, env)], opts);
    }
    function precompile(input, opts) {
      opts = opts || {};
      var env = opts.env || new Environment([]);
      var wrapper = opts.wrapper || precompileGlobal;
      if (opts.isString) {
        return precompileString(input, opts);
      }
      var pathStats = fs.existsSync(input) && fs.statSync(input);
      var precompiled = [];
      var templates = [];
      function addTemplates(dir) {
        fs.readdirSync(dir).forEach(function(file) {
          var filepath = path.join(dir, file);
          var subpath = filepath.substr(path.join(input, "/").length);
          var stat = fs.statSync(filepath);
          if (stat && stat.isDirectory()) {
            subpath += "/";
            if (!match(subpath, opts.exclude)) {
              addTemplates(filepath);
            }
          } else if (match(subpath, opts.include)) {
            templates.push(filepath);
          }
        });
      }
      if (pathStats.isFile()) {
        precompiled.push(_precompile(fs.readFileSync(input, "utf-8"), opts.name || input, env));
      } else if (pathStats.isDirectory()) {
        addTemplates(input);
        for (var i = 0; i < templates.length; i++) {
          var name = templates[i].replace(path.join(input, "/"), "");
          try {
            precompiled.push(_precompile(fs.readFileSync(templates[i], "utf-8"), name, env));
          } catch (e) {
            if (opts.force) {
              console.error(e);
            } else {
              throw e;
            }
          }
        }
      }
      return wrapper(precompiled, opts);
    }
    function _precompile(str, name, env) {
      env = env || new Environment([]);
      var asyncFilters = env.asyncFilters;
      var extensions = env.extensionsList;
      var template;
      name = name.replace(/\\/g, "/");
      try {
        template = compiler.compile(str, asyncFilters, extensions, name, env.opts);
      } catch (err) {
        throw _prettifyError(name, false, err);
      }
      return {
        name,
        template
      };
    }
    module.exports = {
      precompile,
      precompileString
    };
  }
});

// node_modules/nunjucks/src/jinja-compat.js
var require_jinja_compat = __commonJS({
  "node_modules/nunjucks/src/jinja-compat.js"(exports, module) {
    "use strict";
    function installCompat() {
      "use strict";
      var runtime = this.runtime;
      var lib = this.lib;
      var Compiler = this.compiler.Compiler;
      var Parser = this.parser.Parser;
      var nodes = this.nodes;
      var lexer = this.lexer;
      var orig_contextOrFrameLookup = runtime.contextOrFrameLookup;
      var orig_memberLookup = runtime.memberLookup;
      var orig_Compiler_assertType;
      var orig_Parser_parseAggregate;
      if (Compiler) {
        orig_Compiler_assertType = Compiler.prototype.assertType;
      }
      if (Parser) {
        orig_Parser_parseAggregate = Parser.prototype.parseAggregate;
      }
      function uninstall() {
        runtime.contextOrFrameLookup = orig_contextOrFrameLookup;
        runtime.memberLookup = orig_memberLookup;
        if (Compiler) {
          Compiler.prototype.assertType = orig_Compiler_assertType;
        }
        if (Parser) {
          Parser.prototype.parseAggregate = orig_Parser_parseAggregate;
        }
      }
      runtime.contextOrFrameLookup = function contextOrFrameLookup(context, frame, key) {
        var val = orig_contextOrFrameLookup.apply(this, arguments);
        if (val !== void 0) {
          return val;
        }
        switch (key) {
          case "True":
            return true;
          case "False":
            return false;
          case "None":
            return null;
          default:
            return void 0;
        }
      };
      function getTokensState(tokens) {
        return {
          index: tokens.index,
          lineno: tokens.lineno,
          colno: tokens.colno
        };
      }
      if (process.env.BUILD_TYPE !== "SLIM" && nodes && Compiler && Parser) {
        var Slice = nodes.Node.extend("Slice", {
          fields: ["start", "stop", "step"],
          init: function init(lineno, colno, start, stop, step) {
            start = start || new nodes.Literal(lineno, colno, null);
            stop = stop || new nodes.Literal(lineno, colno, null);
            step = step || new nodes.Literal(lineno, colno, 1);
            this.parent(lineno, colno, start, stop, step);
          }
        });
        Compiler.prototype.assertType = function assertType(node) {
          if (node instanceof Slice) {
            return;
          }
          orig_Compiler_assertType.apply(this, arguments);
        };
        Compiler.prototype.compileSlice = function compileSlice(node, frame) {
          this._emit("(");
          this._compileExpression(node.start, frame);
          this._emit("),(");
          this._compileExpression(node.stop, frame);
          this._emit("),(");
          this._compileExpression(node.step, frame);
          this._emit(")");
        };
        Parser.prototype.parseAggregate = function parseAggregate() {
          var _this = this;
          var origState = getTokensState(this.tokens);
          origState.colno--;
          origState.index--;
          try {
            return orig_Parser_parseAggregate.apply(this);
          } catch (e) {
            var errState = getTokensState(this.tokens);
            var rethrow = function rethrow2() {
              lib._assign(_this.tokens, errState);
              return e;
            };
            lib._assign(this.tokens, origState);
            this.peeked = false;
            var tok = this.peekToken();
            if (tok.type !== lexer.TOKEN_LEFT_BRACKET) {
              throw rethrow();
            } else {
              this.nextToken();
            }
            var node = new Slice(tok.lineno, tok.colno);
            var isSlice = false;
            for (var i = 0; i <= node.fields.length; i++) {
              if (this.skip(lexer.TOKEN_RIGHT_BRACKET)) {
                break;
              }
              if (i === node.fields.length) {
                if (isSlice) {
                  this.fail("parseSlice: too many slice components", tok.lineno, tok.colno);
                } else {
                  break;
                }
              }
              if (this.skip(lexer.TOKEN_COLON)) {
                isSlice = true;
              } else {
                var field = node.fields[i];
                node[field] = this.parseExpression();
                isSlice = this.skip(lexer.TOKEN_COLON) || isSlice;
              }
            }
            if (!isSlice) {
              throw rethrow();
            }
            return new nodes.Array(tok.lineno, tok.colno, [node]);
          }
        };
      }
      function sliceLookup(obj, start, stop, step) {
        obj = obj || [];
        if (start === null) {
          start = step < 0 ? obj.length - 1 : 0;
        }
        if (stop === null) {
          stop = step < 0 ? -1 : obj.length;
        } else if (stop < 0) {
          stop += obj.length;
        }
        if (start < 0) {
          start += obj.length;
        }
        var results = [];
        for (var i = start; ; i += step) {
          if (i < 0 || i > obj.length) {
            break;
          }
          if (step > 0 && i >= stop) {
            break;
          }
          if (step < 0 && i <= stop) {
            break;
          }
          results.push(runtime.memberLookup(obj, i));
        }
        return results;
      }
      function hasOwnProp(obj, key) {
        return Object.prototype.hasOwnProperty.call(obj, key);
      }
      var ARRAY_MEMBERS = {
        pop: function pop(index) {
          if (index === void 0) {
            return this.pop();
          }
          if (index >= this.length || index < 0) {
            throw new Error("KeyError");
          }
          return this.splice(index, 1);
        },
        append: function append(element) {
          return this.push(element);
        },
        remove: function remove(element) {
          for (var i = 0; i < this.length; i++) {
            if (this[i] === element) {
              return this.splice(i, 1);
            }
          }
          throw new Error("ValueError");
        },
        count: function count(element) {
          var count2 = 0;
          for (var i = 0; i < this.length; i++) {
            if (this[i] === element) {
              count2++;
            }
          }
          return count2;
        },
        index: function index(element) {
          var i;
          if ((i = this.indexOf(element)) === -1) {
            throw new Error("ValueError");
          }
          return i;
        },
        find: function find(element) {
          return this.indexOf(element);
        },
        insert: function insert(index, elem) {
          return this.splice(index, 0, elem);
        }
      };
      var OBJECT_MEMBERS = {
        items: function items() {
          return lib._entries(this);
        },
        values: function values() {
          return lib._values(this);
        },
        keys: function keys() {
          return lib.keys(this);
        },
        get: function get(key, def) {
          var output = this[key];
          if (output === void 0) {
            output = def;
          }
          return output;
        },
        has_key: function has_key(key) {
          return hasOwnProp(this, key);
        },
        pop: function pop(key, def) {
          var output = this[key];
          if (output === void 0 && def !== void 0) {
            output = def;
          } else if (output === void 0) {
            throw new Error("KeyError");
          } else {
            delete this[key];
          }
          return output;
        },
        popitem: function popitem() {
          var keys = lib.keys(this);
          if (!keys.length) {
            throw new Error("KeyError");
          }
          var k = keys[0];
          var val = this[k];
          delete this[k];
          return [k, val];
        },
        setdefault: function setdefault(key, def) {
          if (def === void 0) {
            def = null;
          }
          if (!(key in this)) {
            this[key] = def;
          }
          return this[key];
        },
        update: function update(kwargs) {
          lib._assign(this, kwargs);
          return null;
        }
      };
      OBJECT_MEMBERS.iteritems = OBJECT_MEMBERS.items;
      OBJECT_MEMBERS.itervalues = OBJECT_MEMBERS.values;
      OBJECT_MEMBERS.iterkeys = OBJECT_MEMBERS.keys;
      runtime.memberLookup = function memberLookup(obj, val, autoescape) {
        if (arguments.length === 4) {
          return sliceLookup.apply(this, arguments);
        }
        obj = obj || {};
        if (lib.isArray(obj) && hasOwnProp(ARRAY_MEMBERS, val)) {
          return ARRAY_MEMBERS[val].bind(obj);
        }
        if (lib.isObject(obj) && hasOwnProp(OBJECT_MEMBERS, val)) {
          return OBJECT_MEMBERS[val].bind(obj);
        }
        return orig_memberLookup.apply(this, arguments);
      };
      return uninstall;
    }
    module.exports = installCompat;
  }
});

// node_modules/nunjucks/index.js
var require_nunjucks = __commonJS({
  "node_modules/nunjucks/index.js"(exports, module) {
    "use strict";
    var lib = require_lib();
    var _require = require_environment();
    var Environment = _require.Environment;
    var Template = _require.Template;
    var Loader = require_loader();
    var loaders = require_loaders();
    var precompile = require_precompile();
    var compiler = require_compiler();
    var parser = require_parser();
    var lexer = require_lexer();
    var runtime = require_runtime();
    var nodes = require_nodes();
    var installJinjaCompat = require_jinja_compat();
    var e;
    function configure(templatesPath, opts) {
      opts = opts || {};
      if (lib.isObject(templatesPath)) {
        opts = templatesPath;
        templatesPath = null;
      }
      var TemplateLoader;
      if (loaders.FileSystemLoader) {
        TemplateLoader = new loaders.FileSystemLoader(templatesPath, {
          watch: opts.watch,
          noCache: opts.noCache
        });
      } else if (loaders.WebLoader) {
        TemplateLoader = new loaders.WebLoader(templatesPath, {
          useCache: opts.web && opts.web.useCache,
          async: opts.web && opts.web.async
        });
      }
      e = new Environment(TemplateLoader, opts);
      if (opts && opts.express) {
        e.express(opts.express);
      }
      return e;
    }
    module.exports = {
      Environment,
      Template,
      Loader,
      FileSystemLoader: loaders.FileSystemLoader,
      NodeResolveLoader: loaders.NodeResolveLoader,
      PrecompiledLoader: loaders.PrecompiledLoader,
      WebLoader: loaders.WebLoader,
      compiler,
      parser,
      lexer,
      runtime,
      lib,
      nodes,
      installJinjaCompat,
      configure,
      reset: function reset() {
        e = void 0;
      },
      compile: function compile(src, env, path, eagerCompile) {
        if (!e) {
          configure();
        }
        return new Template(src, env, path, eagerCompile);
      },
      render: function render(name, ctx, cb) {
        if (!e) {
          configure();
        }
        return e.render(name, ctx, cb);
      },
      renderString: function renderString(src, ctx, cb) {
        if (!e) {
          configure();
        }
        return e.renderString(src, ctx, cb);
      },
      precompile: precompile ? precompile.precompile : void 0,
      precompileString: precompile ? precompile.precompileString : void 0
    };
  }
});

// src/cli.ts
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { join as join13 } from "node:path";

// src/engine.ts
import { execFileSync } from "node:child_process";
import { hostname, platform, userInfo } from "node:os";
import { basename, join as join11 } from "node:path";

// src/config.ts
import { existsSync, readFileSync } from "node:fs";
import { join as join2 } from "node:path";

// src/fsutil.ts
import { createHash } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
function hashBuffer(buf) {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}
function atomicWrite(path, data) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.skilletor-tmp-${process.pid}-${Math.random().toString(36).slice(2)}`);
  try {
    writeFileSync(tmp, data);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

// src/config.ts
var INSTALL_KEYS = { skills: "skill", agents: "agent", rules: "rule" };
var ConfigError = class extends Error {
  name = "ConfigError";
};
var ALLOWED_KEYS = /* @__PURE__ */ new Set(["sources", "install", "vars", "gitignore", "checkInterval"]);
var SOURCE_KEYS = /* @__PURE__ */ new Set(["git", "ref", "url", "local"]);
function readConfigFile(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new ConfigError(`${path}: cannot read config (${err.message})`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${err.message})`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path}: top level must be a JSON object`);
  }
  validateKeys(value, path);
  return value;
}
function validateKeys(obj, path) {
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(
        `${path}: unknown key "${key}" (allowed: ${[...ALLOWED_KEYS].join(", ")})`
      );
    }
  }
}
function asObject(value, path, where) {
  if (value === void 0) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigError(`${path}: ${where} must be an object`);
  }
  return value;
}
function parseSources(obj, path) {
  const sources = /* @__PURE__ */ new Map();
  const raw = asObject(obj.sources, path, "sources");
  for (const [name, def] of Object.entries(raw)) {
    const d = asObject(def, path, `sources.${name}`);
    for (const key of Object.keys(d)) {
      if (!SOURCE_KEYS.has(key)) {
        throw new ConfigError(`${path}: sources.${name}: unknown key "${key}"`);
      }
    }
    const src = { name, origin: "project" };
    if (typeof d.git === "string") src.git = d.git;
    if (typeof d.ref === "string") src.ref = d.ref;
    if (typeof d.local === "string") src.local = d.local;
    if (d.url !== void 0) {
      if (typeof d.url !== "string" || !d.url.startsWith("https://")) {
        throw new ConfigError(`${path}: sources.${name}.url must be an https:// URL`);
      }
      src.url = d.url;
    }
    if (src.git === void 0 && src.url === void 0 && src.local === void 0) {
      throw new ConfigError(`${path}: sources.${name} needs one of "git", "url" or "local"`);
    }
    sources.set(name, src);
  }
  return sources;
}
function mergeSource(base, incoming, origin) {
  const merged = { ...base ?? { name: incoming.name, origin }, ...incoming };
  merged.origin = base?.origin === "user" || origin === "user" ? "user" : "project";
  return merged;
}
function parseInstall(obj, path, scope, known) {
  const install = asObject(obj.install, path, "install");
  for (const key of Object.keys(install)) {
    if (!(key in INSTALL_KEYS)) {
      throw new ConfigError(`${path}: install.${key} is not a valid type (skills, agents, rules)`);
    }
  }
  const items = [];
  const seen = /* @__PURE__ */ new Map();
  for (const [key, type] of Object.entries(INSTALL_KEYS)) {
    const list = install[key];
    if (list === void 0) continue;
    if (!Array.isArray(list)) throw new ConfigError(`${path}: install.${key} must be an array`);
    list.forEach((entry, i) => {
      if (typeof entry !== "string") {
        throw new ConfigError(`${path}: install.${key}[${i}] must be a string`);
      }
      const item = parseEntry(entry, type, path, `install.${key}[${i}]`);
      if (!known.has(item.source)) {
        throw new ConfigError(
          `${path}: ${scope} install "${entry}" references unknown source "${item.source}"`
        );
      }
      const targetKey = `${item.type}/${item.name}`;
      const prev = seen.get(targetKey);
      if (prev !== void 0) {
        throw new ConfigError(
          `${path}: duplicate ${item.type} target "${item.name}" declared as ${prev} and ${entry}`
        );
      }
      seen.set(targetKey, entry);
      items.push(item);
    });
  }
  return items;
}
function parseEntry(entry, type, path, where) {
  const at = entry.lastIndexOf("@");
  if (at <= 0 || at === entry.length - 1) {
    throw new ConfigError(`${path}: ${where} "${entry}" must be name@source`);
  }
  const source = entry.slice(at + 1);
  let name = entry.slice(0, at);
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix !== type) {
      throw new ConfigError(
        `${path}: ${where} "${entry}" declares type "${prefix}" but is under ${type}s`
      );
    }
    name = name.slice(colon + 1);
  }
  if (name.length === 0) throw new ConfigError(`${path}: ${where} "${entry}" has an empty name`);
  return { type, name, source, target: `${type}s/${name}`, raw: entry };
}
function mergeVars(...objs) {
  const out = {};
  for (const o of objs) if (o) Object.assign(out, o);
  return out;
}
function loadConfig(opts) {
  const userPath = join2(opts.home, ".claude", "skilletor.json");
  const user = readConfigFile(userPath);
  if ("gitignore" in user) {
    throw new ConfigError(`${userPath}: "gitignore" is project-only`);
  }
  const hasProject = opts.projectDir !== void 0;
  const projectPath = hasProject ? join2(opts.projectDir, ".claude", "skilletor.json") : "";
  const localPath = hasProject ? join2(opts.projectDir, ".claude", "skilletor.local.json") : "";
  const project = hasProject ? readConfigFile(projectPath) : {};
  const local = hasProject ? readConfigFile(localPath) : {};
  for (const [obj, p] of [[project, projectPath], [local, localPath]]) {
    if (p && "checkInterval" in obj) {
      throw new ConfigError(`${p}: "checkInterval" is user-only`);
    }
  }
  const userSources = parseSources(user, userPath);
  const projectSources = hasProject ? parseSources(project, projectPath) : /* @__PURE__ */ new Map();
  const localSources = hasProject ? parseSources(local, localPath) : /* @__PURE__ */ new Map();
  const sources = /* @__PURE__ */ new Map();
  for (const [name, s] of projectSources) sources.set(name, { ...s, origin: "project" });
  for (const [name, s] of userSources) sources.set(name, mergeSource(sources.get(name), s, "user"));
  for (const [name, s] of localSources) sources.set(name, mergeSource(sources.get(name), s, "user"));
  const checkInterval = numberOr(user.checkInterval, 600, userPath, "checkInterval");
  const userScope = {
    scope: "user",
    install: parseInstall(user, userPath, "user", userSources),
    vars: mergeVars(asObject(user.vars, userPath, "vars"))
  };
  let projectScope;
  if (hasProject) {
    const projectInstall = parseInstall(project, projectPath, "project", sources);
    const localInstall = parseInstall(local, localPath, "project", sources);
    projectScope = {
      scope: "project",
      install: dedupeAcross(projectInstall, localInstall, projectPath),
      vars: mergeVars(
        asObject(user.vars, userPath, "vars"),
        asObject(project.vars, projectPath, "vars"),
        asObject(local.vars, localPath, "vars")
      ),
      gitignore: boolOr(local.gitignore ?? project.gitignore, true, projectPath, "gitignore")
    };
  }
  return { sources, checkInterval, user: userScope, project: projectScope };
}
function dedupeAcross(a, b, path) {
  const seen = /* @__PURE__ */ new Map();
  const out = [];
  for (const item of [...a, ...b]) {
    const key = `${item.type}/${item.name}`;
    const prev = seen.get(key);
    if (prev !== void 0) {
      throw new ConfigError(
        `${path}: duplicate ${item.type} target "${item.name}" declared as ${prev} and ${item.raw}`
      );
    }
    seen.set(key, item.raw);
    out.push(item);
  }
  return out;
}
function numberOr(value, fallback, path, key) {
  if (value === void 0) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${path}: "${key}" must be a number`);
  }
  return value;
}
function boolOr(value, fallback, path, key) {
  if (value === void 0) return fallback;
  if (typeof value !== "boolean") throw new ConfigError(`${path}: "${key}" must be a boolean`);
  return value;
}
function loadRaw(path) {
  if (!existsSync(path)) return {};
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("top level must be an object");
    }
    return value;
  } catch (err) {
    throw new ConfigError(`${path}: invalid JSON (${err.message})`);
  }
}
function saveRaw(path, cfg) {
  atomicWrite(path, JSON.stringify(cfg, null, 2) + "\n");
}
function addSource(path, name, def) {
  const cfg = loadRaw(path);
  const sources = cfg.sources ?? {};
  sources[name] = def;
  cfg.sources = sources;
  saveRaw(path, cfg);
}
function removeSource(path, name) {
  const cfg = loadRaw(path);
  const sources = cfg.sources;
  if (sources && name in sources) {
    delete sources[name];
    if (Object.keys(sources).length === 0) delete cfg.sources;
    saveRaw(path, cfg);
  }
}
var INSTALL_KEY = { skill: "skills", agent: "agents", rule: "rules" };
function addInstallEntry(path, type, entry) {
  const cfg = loadRaw(path);
  const install = cfg.install ?? {};
  const key = INSTALL_KEY[type];
  const list = Array.isArray(install[key]) ? install[key] : [];
  if (!list.includes(entry)) list.push(entry);
  install[key] = list;
  cfg.install = install;
  saveRaw(path, cfg);
}
function removeInstallEntries(path, name, source) {
  const cfg = loadRaw(path);
  const install = cfg.install;
  if (!install) return 0;
  let removed = 0;
  for (const key of Object.values(INSTALL_KEY)) {
    const list = install[key];
    if (!Array.isArray(list)) continue;
    const kept = list.filter((e) => {
      const at = e.lastIndexOf("@");
      const eName = (at > 0 ? e.slice(0, at) : e).replace(/^[a-z]+:/, "");
      const eSource = at > 0 ? e.slice(at + 1) : void 0;
      const match = eName === name && (source === void 0 || eSource === source);
      if (match) removed++;
      return !match;
    });
    if (kept.length) install[key] = kept;
    else delete install[key];
  }
  if (Object.keys(install).length === 0) delete cfg.install;
  if (removed) saveRaw(path, cfg);
  return removed;
}

// src/sources/local.ts
import { existsSync as existsSync2, statSync } from "node:fs";
import { join as join3 } from "node:path";
function expandHome(path, home) {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join3(home, path.slice(2));
  return path;
}
var LocalSource = class {
  dir;
  constructor(localPath, home) {
    this.dir = expandHome(localPath, home);
  }
  exists() {
    try {
      return statSync(this.dir).isDirectory();
    } catch {
      return false;
    }
  }
  async resolve(_cachedVersion) {
    if (!existsSync2(this.dir)) {
      throw new Error(`local source directory does not exist: ${this.dir}`);
    }
    return { dir: this.dir, version: "local" };
  }
  async check(_cachedVersion) {
    return true;
  }
};

// src/sources/git.ts
import { execFile } from "node:child_process";
import { createHash as createHash2 } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync2 } from "node:fs";
import { join as join4 } from "node:path";
var DEFAULT_TIMEOUT_MS = 6e4;
var GitSource = class {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  cacheDir() {
    const hash = createHash2("sha256").update(this.opts.url).digest("hex").slice(0, 16);
    return join4(this.opts.cacheRoot, hash);
  }
  run(cwd, args, timeoutMs) {
    return new Promise((resolvePromise, reject) => {
      execFile(
        "git",
        args,
        {
          cwd: cwd || void 0,
          timeout: timeoutMs ?? this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
          maxBuffer: 32 * 1024 * 1024
        },
        (err, stdout, stderr) => {
          if (err) reject(new Error(`git ${args.join(" ")}: ${stderr || err.message}`));
          else resolvePromise(stdout.toString());
        }
      );
    });
  }
  isRepo(dir) {
    return existsSync3(join4(dir, ".git"));
  }
  async resolve(_cachedVersion) {
    const dir = this.cacheDir();
    const ref = this.opts.ref;
    try {
      if (!this.isRepo(dir)) {
        mkdirSync2(dir, { recursive: true });
        await this.run(dir, ["init", "-q"]);
        await this.run(dir, ["remote", "add", "origin", this.opts.url]);
      } else {
        await this.run(dir, ["remote", "set-url", "origin", this.opts.url]).catch(() => {
        });
      }
      let resetTarget = "FETCH_HEAD";
      if (ref && isCommitish(ref)) {
        try {
          await this.run(dir, ["fetch", "--depth", "1", "origin", ref]);
        } catch {
          await this.run(dir, ["fetch", "origin"]);
          resetTarget = ref;
        }
      } else {
        await this.run(dir, ["fetch", "--depth", "1", "origin", ref ?? "HEAD"]);
      }
      await this.run(dir, ["reset", "--hard", resetTarget]);
      return { dir, version: await this.version(dir) };
    } catch (err) {
      if (this.isRepo(dir)) {
        try {
          return {
            dir,
            version: await this.version(dir),
            warning: `git fetch failed for ${this.opts.url}, using cache (${err.message})`
          };
        } catch {
        }
      }
      throw new Error(`git source ${this.opts.url} failed: ${err.message}`);
    }
  }
  async version(dir) {
    const sha = (await this.run(dir, ["rev-parse", "--short", "HEAD"])).trim();
    return `git:${sha}`;
  }
  async check(cachedVersion) {
    const ref = this.opts.ref;
    if (ref && isCommitish(ref)) return false;
    if (!cachedVersion) return true;
    const out = await this.run("", ["ls-remote", this.opts.url, ref ?? "HEAD"], this.opts.timeoutMs);
    const remote = out.split(/\s+/)[0] ?? "";
    const cached = cachedVersion.replace(/^git:/, "");
    return !(cached.length > 0 && remote.startsWith(cached));
  }
};
function isCommitish(ref) {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

// src/sources/url.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync4, mkdirSync as mkdirSync3, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join5, resolve as resolvePath, sep } from "node:path";
import { gunzipSync } from "node:zlib";
var TarError = class extends Error {
  name = "TarError";
};
var DEFAULT_TIMEOUT_MS2 = 6e4;
var UrlSource = class {
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  cacheDir() {
    const hash = createHash3("sha256").update(this.opts.url).digest("hex").slice(0, 16);
    return join5(this.opts.cacheRoot, hash);
  }
  assertScheme() {
    const u = new URL(this.opts.url);
    if (u.protocol === "https:") return;
    const localHttp = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
    if (this.opts.allowHttp && localHttp) return;
    throw new Error(`url source must be https://: ${this.opts.url}`);
  }
  async request(method, headers) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS2);
    try {
      return await fetch(this.opts.url, { method, headers, signal: ctrl.signal, redirect: "follow" });
    } finally {
      clearTimeout(timer);
    }
  }
  async resolve(cachedVersion) {
    this.assertScheme();
    const dir = this.cacheDir();
    try {
      const headers = {};
      const etag = cachedVersion?.startsWith("etag:") ? cachedVersion.slice(5) : void 0;
      if (etag && existsSync4(dir)) headers["If-None-Match"] = etag;
      const res = await this.request("GET", headers);
      if (res.status === 304 && existsSync4(dir)) {
        return { dir, version: cachedVersion };
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = Buffer.from(await res.arrayBuffer());
      const resEtag = res.headers.get("etag");
      const version = resEtag ? `etag:${resEtag}` : `sha256:${createHash3("sha256").update(body).digest("hex")}`;
      const entries = stripTopLevel(parseTar(gunzipSync(body)));
      writeEntries(dir, entries);
      return { dir, version };
    } catch (err) {
      if (err instanceof TarError) {
        throw new Error(`url source ${this.opts.url} failed: ${err.message}`);
      }
      if (existsSync4(dir)) {
        return {
          dir,
          version: cachedVersion ?? "unknown",
          warning: `download failed for ${this.opts.url}, using cache (${err.message})`
        };
      }
      throw new Error(`url source ${this.opts.url} failed: ${err.message}`);
    }
  }
  async check(cachedVersion) {
    this.assertScheme();
    const res = await this.request("HEAD", {});
    const etag = res.headers.get("etag");
    if (!etag || !cachedVersion?.startsWith("etag:")) return true;
    return etag !== cachedVersion.slice(5);
  }
};
function readString(block, offset, length) {
  const raw = block.subarray(offset, offset + length);
  const end = raw.indexOf(0);
  return raw.toString("utf8", 0, end === -1 ? length : end);
}
function readOctal(block, offset, length) {
  const s = readString(block, offset, length).trim();
  return s ? parseInt(s, 8) : 0;
}
function parseTar(buf) {
  const entries = [];
  let offset = 0;
  let longName;
  let paxPath;
  while (offset + 512 <= buf.length) {
    const block = buf.subarray(offset, offset + 512);
    if (block.every((b) => b === 0)) break;
    const rawName = readString(block, 0, 100);
    const prefix = readString(block, 345, 155);
    const size = readOctal(block, 124, 12);
    const typeflag = String.fromCharCode(block[156] ?? 0);
    offset += 512;
    const data = buf.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;
    if (typeflag === "L") {
      longName = readString(data, 0, data.length).replace(/\0+$/, "");
      continue;
    }
    if (typeflag === "x" || typeflag === "g") {
      paxPath = parsePaxPath(data) ?? paxPath;
      continue;
    }
    if (typeflag === "2" || typeflag === "1") {
      throw new TarError(`unsafe tar entry (symlink/hardlink): ${rawName}`);
    }
    const name = paxPath ?? longName ?? (prefix ? `${prefix}/${rawName}` : rawName);
    longName = void 0;
    paxPath = void 0;
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "5") continue;
    assertSafe(name);
    if (typeflag === "5" || name.endsWith("/")) {
      entries.push({ name: name.replace(/\/+$/, ""), type: "dir", data: Buffer.alloc(0) });
    } else {
      entries.push({ name, type: "file", data });
    }
  }
  return entries;
}
function parsePaxPath(data) {
  for (const line of data.toString("utf8").split("\n")) {
    const m = /^\d+ path=(.*)$/.exec(line);
    if (m) return m[1];
  }
  return void 0;
}
function assertSafe(name) {
  if (name === "" || name.startsWith("/") || name.startsWith("\\") || /^[a-zA-Z]:/.test(name)) {
    throw new TarError(`unsafe tar entry (absolute path): ${name || "<empty>"}`);
  }
  if (name.split("/").some((seg) => seg === "..")) {
    throw new TarError(`unsafe tar entry (path traversal): ${name}`);
  }
}
function stripTopLevel(entries) {
  const tops = new Set(entries.map((e) => e.name.split("/")[0]).filter(Boolean));
  const nested = entries.some((e) => e.name.includes("/"));
  if (tops.size !== 1 || !nested) return entries;
  const top = [...tops][0];
  const prefix = `${top}/`;
  return entries.map((e) => ({ ...e, name: e.name === top ? "" : e.name.startsWith(prefix) ? e.name.slice(prefix.length) : e.name })).filter((e) => e.name.length > 0);
}
function writeEntries(dir, entries) {
  rmSync2(dir, { recursive: true, force: true });
  mkdirSync3(dir, { recursive: true });
  const root = resolvePath(dir);
  for (const e of entries) {
    const dest = resolvePath(join5(dir, e.name));
    if (dest !== root && !dest.startsWith(root + sep)) {
      throw new TarError(`unsafe tar entry (escapes target): ${e.name}`);
    }
    if (e.type === "dir") {
      mkdirSync3(dest, { recursive: true });
    } else {
      mkdirSync3(dirname2(dest), { recursive: true });
      writeFileSync2(dest, e.data);
    }
  }
}

// src/catalog.ts
import { existsSync as existsSync5, lstatSync, readFileSync as readFileSync2, readdirSync } from "node:fs";
import { join as join6, relative } from "node:path";
var CatalogError = class extends Error {
  name = "CatalogError";
};
var TYPE_DIRS = [
  { dir: "skills", type: "skill" },
  { dir: "agents", type: "agent" },
  { dir: "rules", type: "rule" }
];
function noSymlink(path) {
  const st = lstatSync(path);
  if (st.isSymbolicLink()) {
    throw new CatalogError(`symlink not allowed in source: ${path}`);
  }
  return st;
}
function walkFiles(dir, sourceDir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join6(dir, entry);
    const st = noSymlink(p);
    if (st.isDirectory()) out.push(...walkFiles(p, sourceDir));
    else if (st.isFile()) out.push(relative(sourceDir, p));
  }
  return out.sort();
}
function frontmatter(text) {
  if (!text.startsWith("---")) return {};
  const firstNl = text.indexOf("\n");
  if (firstNl === -1) return {};
  const close = text.indexOf("\n---", firstNl);
  if (close === -1) return {};
  const block = text.slice(firstNl + 1, close);
  const out = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) out[m[1]] = unquote(m[2].trim());
  }
  return out;
}
function unquote(v) {
  if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}
function descriptionOf(filePath) {
  return frontmatter(readFileSync2(filePath, "utf8")).description;
}
function skillFile(dir) {
  for (const candidate of ["SKILL.md", "SKILL.md.njk"]) {
    const p = join6(dir, candidate);
    if (existsSync5(p)) {
      noSymlink(p);
      return p;
    }
  }
  return void 0;
}
function itemName(fileName) {
  const m = /^(.+?)\.md(\.njk)?$/.exec(fileName);
  return m ? m[1] : void 0;
}
function scan(dir) {
  const items = [];
  for (const { dir: sub, type } of TYPE_DIRS) {
    const typeDir = join6(dir, sub);
    if (!existsSync5(typeDir)) continue;
    noSymlink(typeDir);
    for (const entry of readdirSync(typeDir)) {
      const p = join6(typeDir, entry);
      const st = noSymlink(p);
      if (type === "skill") {
        if (!st.isDirectory()) continue;
        const file = skillFile(p);
        if (!file) continue;
        items.push({ type, name: entry, description: descriptionOf(file), files: walkFiles(p, dir) });
      } else {
        if (!st.isFile()) continue;
        const name = itemName(entry);
        if (name === void 0) continue;
        items.push({ type, name, description: descriptionOf(p), files: [relative(dir, p)] });
      }
    }
  }
  return { items, meta: readSourceMeta(dir) };
}
function readSourceMeta(dir) {
  const p = join6(dir, "skilletor.json");
  if (!existsSync5(p)) return {};
  noSymlink(p);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync2(p, "utf8"));
  } catch (err) {
    throw new CatalogError(`${p}: invalid JSON (${err.message})`);
  }
  if (parsed === null || typeof parsed !== "object") return {};
  const obj = parsed;
  const meta = {};
  if (typeof obj.description === "string") meta.description = obj.description;
  if (obj.vars && typeof obj.vars === "object") meta.vars = obj.vars;
  return meta;
}

// src/render.ts
var import_nunjucks = __toESM(require_nunjucks(), 1);
import { readFileSync as readFileSync3 } from "node:fs";
import { join as join7, resolve as resolvePath2, sep as sep2 } from "node:path";
var RenderError = class extends Error {
  name = "RenderError";
};
function makeLoader(root) {
  const base = resolvePath2(root);
  return {
    async: false,
    getSource(name) {
      const path = resolvePath2(base, name);
      if (path !== base && !path.startsWith(base + sep2)) {
        throw new RenderError(`template escapes source root: ${name}`);
      }
      let src;
      try {
        src = readFileSync3(path, "utf8");
      } catch {
        return null;
      }
      return { src, path, noCache: true };
    }
  };
}
function makeEnv(sourceDir) {
  return new import_nunjucks.default.Environment(makeLoader(sourceDir), {
    autoescape: false,
    throwOnUndefined: true
  });
}
function build(item, sourceDir, context) {
  const env = makeEnv(sourceDir);
  const out = /* @__PURE__ */ new Map();
  for (const file of item.files) {
    if (file.endsWith(".njk")) {
      let rendered;
      try {
        rendered = env.render(file, context);
      } catch (err) {
        if (err instanceof RenderError) throw err;
        throw new RenderError(`${file}: ${err.message}`);
      }
      out.set(file.slice(0, -".njk".length), Buffer.from(rendered, "utf8"));
    } else {
      out.set(file, readFileSync3(join7(sourceDir, file)));
    }
  }
  return out;
}

// src/apply.ts
import { existsSync as existsSync6, readFileSync as readFileSync5, readdirSync as readdirSync2, rmdirSync, rmSync as rmSync3 } from "node:fs";
import { dirname as dirname3, join as join8, resolve as resolvePath3, sep as sep3 } from "node:path";

// src/lock.ts
import { readFileSync as readFileSync4 } from "node:fs";
var LockError = class extends Error {
  name = "LockError";
};
function readLock(path) {
  let text;
  try {
    text = readFileSync4(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw new LockError(`${path}: cannot read lock (${err.message})`);
  }
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("expected an object");
    }
    return value;
  } catch (err) {
    throw new LockError(`${path}: invalid lock JSON (${err.message})`);
  }
}
function serializeLock(lock) {
  const out = {};
  for (const key of Object.keys(lock).sort()) {
    const entry = lock[key];
    const files = {};
    for (const f of Object.keys(entry.files).sort()) files[f] = entry.files[f];
    out[key] = { source: entry.source, version: entry.version, files };
  }
  return JSON.stringify(out, null, 2) + "\n";
}
function writeLock(path, lock) {
  atomicWrite(path, serializeLock(lock));
}

// src/apply.ts
var ApplyError = class extends Error {
  name = "ApplyError";
};
var NAME_RE = /^[A-Za-z0-9._-]+$/;
function apply(plan, opts) {
  const targetDir = resolvePath3(opts.targetDir);
  const lockPath = join8(targetDir, "skilletor.lock.json");
  const oldLock = readLock(lockPath);
  const newLock = {};
  const res = { added: [], updated: [], removed: [], unchanged: [], conflicts: [], overwritten: [] };
  const dirsTouched = /* @__PURE__ */ new Set();
  const planned = new Set(plan.map((i) => i.key));
  for (const it of plan) {
    if (!NAME_RE.test(it.name)) throw new ApplyError(`invalid item name: ${it.name}`);
    const existing = oldLock[it.key];
    const entryFiles = {};
    let wrote = false;
    let removedFile = false;
    for (const [rel, buf] of it.output) {
      const abs = safeJoin(targetDir, rel);
      const desired = hashBuffer(buf);
      const locked = existing?.files[rel];
      const onDisk = existsSync6(abs);
      if (onDisk) {
        const diskHash = hashBuffer(readFileSync5(abs));
        if (locked === void 0 && !opts.force) {
          res.conflicts.push({ key: it.key, path: rel });
          continue;
        }
        if (diskHash === desired) {
          entryFiles[rel] = desired;
          continue;
        }
        atomicWrite(abs, buf);
        wrote = true;
        entryFiles[rel] = desired;
        if (locked !== void 0 && diskHash !== locked) {
          res.overwritten.push({ key: it.key, path: rel });
        }
      } else {
        atomicWrite(abs, buf);
        wrote = true;
        entryFiles[rel] = desired;
      }
    }
    if (existing) {
      for (const rel of Object.keys(existing.files)) {
        if (!it.output.has(rel)) {
          removeFile(safeJoin(targetDir, rel), dirsTouched);
          removedFile = true;
        }
      }
    }
    if (Object.keys(entryFiles).length > 0) {
      newLock[it.key] = { source: it.source, version: it.version, files: entryFiles };
    }
    if (existing === void 0) {
      if (wrote) res.added.push(it.key);
      else res.unchanged.push(it.key);
    } else if (wrote || removedFile) {
      res.updated.push(it.key);
    } else {
      res.unchanged.push(it.key);
    }
  }
  const keep = new Set(opts.keep ?? []);
  for (const key of Object.keys(oldLock)) {
    if (planned.has(key)) continue;
    if (keep.has(key)) {
      newLock[key] = oldLock[key];
      continue;
    }
    for (const rel of Object.keys(oldLock[key].files)) {
      removeFile(safeJoin(targetDir, rel), dirsTouched);
    }
    res.removed.push(key);
  }
  pruneEmptyDirs(dirsTouched, targetDir);
  if (serializeLock(newLock) !== serializeLock(oldLock)) {
    writeLock(lockPath, newLock);
  }
  return res;
}
function safeJoin(root, rel) {
  const abs = resolvePath3(join8(root, rel));
  if (abs !== root && !abs.startsWith(root + sep3)) {
    throw new ApplyError(`path escapes target: ${rel}`);
  }
  return abs;
}
function removeFile(abs, dirsTouched) {
  if (existsSync6(abs)) {
    rmSync3(abs, { force: true });
    dirsTouched.add(dirname3(abs));
  }
}
function pruneEmptyDirs(dirs, root) {
  const sorted = [...dirs].sort((a, b) => b.length - a.length);
  for (let dir of sorted) {
    while (dir !== root && dir.startsWith(root + sep3)) {
      if (!existsSync6(dir) || readdirSync2(dir).length > 0) break;
      rmdirSync(dir);
      dir = dirname3(dir);
    }
  }
}

// src/state.ts
import { existsSync as existsSync7, mkdirSync as mkdirSync4, readFileSync as readFileSync6, rmSync as rmSync4, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join9 } from "node:path";
var delay = (ms) => new Promise((r) => setTimeout(r, ms));
var State = class {
  root;
  constructor(root) {
    this.root = root;
    mkdirSync4(root, { recursive: true });
  }
  path(name) {
    return join9(this.root, name);
  }
  readJson(name) {
    try {
      const value = JSON.parse(readFileSync6(this.path(name), "utf8"));
      return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    } catch {
      return {};
    }
  }
  writeJson(name, value) {
    atomicWrite(this.path(name), JSON.stringify(value, null, 2) + "\n");
  }
  // ---- trust ----------------------------------------------------------------
  trust(name, resolved) {
    const trust = this.readJson("trust.json");
    trust[name] = resolved;
    this.writeJson("trust.json", trust);
  }
  isTrusted(source) {
    if (source.origin === "user") return true;
    return this.readJson("trust.json")[source.name] === source.resolved;
  }
  // ---- last-check -----------------------------------------------------------
  isDue(scopeKey, intervalSeconds) {
    const last = this.readJson("last-check.json")[scopeKey];
    if (typeof last !== "number") return true;
    return Date.now() - last >= intervalSeconds * 1e3;
  }
  markChecked(scopeKey) {
    const checks = this.readJson("last-check.json");
    checks[scopeKey] = Date.now();
    this.writeJson("last-check.json", checks);
  }
  // ---- pending report -------------------------------------------------------
  putPendingReport(projectKey, report) {
    const pending = this.readJson("pending-report.json");
    pending[projectKey] = report;
    this.writeJson("pending-report.json", pending);
  }
  takePendingReport(projectKey) {
    const pending = this.readJson("pending-report.json");
    if (!(projectKey in pending)) return void 0;
    const report = pending[projectKey];
    delete pending[projectKey];
    this.writeJson("pending-report.json", pending);
    return report;
  }
  // ---- mutex ----------------------------------------------------------------
  async withLock(fn, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? 5e3;
    const staleMs = opts.staleMs ?? 3e5;
    const pollMs = opts.pollMs ?? 25;
    const lockDir = this.path("sync.lock");
    const ownerFile = join9(lockDir, "owner.json");
    const deadline = Date.now() + timeoutMs;
    for (; ; ) {
      try {
        mkdirSync4(lockDir);
        writeFileSync3(ownerFile, JSON.stringify({ pid: process.pid, at: Date.now() }));
        break;
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
        if (this.isStale(ownerFile, staleMs)) {
          rmSync4(lockDir, { recursive: true, force: true });
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error(`timed out acquiring sync lock at ${lockDir}`);
        }
        await delay(pollMs);
      }
    }
    try {
      return await fn();
    } finally {
      rmSync4(lockDir, { recursive: true, force: true });
    }
  }
  isStale(ownerFile, staleMs) {
    try {
      const owner = JSON.parse(readFileSync6(ownerFile, "utf8"));
      if (typeof owner.at !== "number") return true;
      return Date.now() - owner.at > staleMs;
    } catch {
      return existsSync7(ownerFile) ? false : true;
    }
  }
};

// src/gitignore.ts
import { existsSync as existsSync8, readFileSync as readFileSync7, rmSync as rmSync5 } from "node:fs";
import { join as join10 } from "node:path";
var BEGIN = "# >>> skilletor >>>";
var END = "# <<< skilletor <<<";
function updateGitignore(opts) {
  const path = join10(opts.claudeDir, ".gitignore");
  const existed = existsSync8(path);
  const existing = existed ? readFileSync7(path, "utf8") : "";
  const lines = existing.length ? existing.split("\n") : [];
  const begin = lines.indexOf(BEGIN);
  const end = lines.indexOf(END);
  const hasBlock = begin !== -1 && end !== -1 && end > begin;
  const outside = hasBlock ? [...lines.slice(0, begin), ...lines.slice(end + 1)] : lines;
  let out;
  if (opts.enabled) {
    const block = [BEGIN, ...blockEntries(opts.managedPaths), END];
    if (hasBlock) {
      out = [...lines.slice(0, begin), ...block, ...lines.slice(end + 1)];
    } else {
      const trimmed = trimTrailingEmpty(outside);
      out = trimmed.length ? [...trimmed, "", ...block] : [...block];
    }
  } else {
    out = trimTrailingEmpty(outside);
  }
  const result = out.length && out.some((l) => l.trim() !== "") ? out.join("\n").replace(/\n*$/, "") + "\n" : "";
  if (result === "") {
    if (existed) rmSync5(path, { force: true });
    return;
  }
  if (result !== existing) atomicWrite(path, result);
}
function blockEntries(managedPaths) {
  const set = /* @__PURE__ */ new Set([...managedPaths, "skilletor.lock.json", "skilletor.local.json"]);
  return [...set].sort();
}
function trimTrailingEmpty(lines) {
  const out = [...lines];
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

// src/report.ts
var ACTIVATION = {
  skill: "active now",
  agent: "active after /reload-plugins or restart",
  rule: "active after /reload-plugins or restart"
};
function emptyScopeReport(scope) {
  return { scope, added: [], updated: [], removed: [], unchanged: [], conflicts: [], overwritten: [], warnings: [], trustRequests: [] };
}
function keyToTypeName(key) {
  const [dir, ...rest] = key.split("/");
  const type = dir === "skills" ? "skill" : dir === "agents" ? "agent" : "rule";
  return { type, name: rest.join("/") };
}
function isNotable(s) {
  return Boolean(
    s.added.length || s.updated.length || s.removed.length || s.conflicts.length || s.overwritten.length || s.warnings.length || s.trustRequests.length
  );
}
function reportJson(r) {
  return JSON.stringify(r, null, 2);
}
function reportText(r) {
  if (r.error) return `skilletor: config error, nothing changed \u2014 ${r.error}`;
  const lines = [];
  for (const s of r.scopes) {
    if (!isNotable(s)) continue;
    lines.push(`skilletor: ${s.scope} scope`);
    for (const it of s.added) lines.push(`  + ${it.key} (${ACTIVATION[it.type]})`);
    for (const it of s.updated) lines.push(`  ~ ${it.key} (${ACTIVATION[it.type]})`);
    for (const it of s.removed) lines.push(`  - ${it.key} (removed)`);
    for (const c of s.overwritten) lines.push(`  overwrote local change: ${c.path}`);
    for (const c of s.conflicts) lines.push(`  conflict: ${c.path} already exists (use --force to adopt)`);
    for (const t of s.trustRequests) lines.push(`  trust: source "${t.name}" (${t.url}) \u2014 run: skilletor trust ${t.name}`);
    for (const w of s.warnings) lines.push(`  warning: ${w}`);
  }
  return lines.join("\n");
}

// src/engine.ts
function cacheRootOf(ctx) {
  return ctx.cacheRoot ?? join11(ctx.stateRoot, "cache");
}
function targetDirOf(ctx, scope) {
  return join11(scope === "user" ? ctx.home : ctx.projectDir, ".claude");
}
function identityOf(src) {
  return src.git ?? src.url ?? src.local ?? "";
}
function makeBackend(src, home, cacheRoot) {
  if (src.local) {
    const ls = new LocalSource(src.local, home);
    if (ls.exists()) return ls;
  }
  if (src.git) return new GitSource({ url: src.git, ref: src.ref, cacheRoot });
  if (src.url) return new UrlSource({ url: src.url, cacheRoot });
  if (src.local) return new LocalSource(src.local, home);
  throw new Error(`source ${src.name} has no backend`);
}
function sourceVersion(lock, sourceName) {
  for (const entry of Object.values(lock)) if (entry.source === sourceName) return entry.version;
  return void 0;
}
function gitRemote(dir) {
  try {
    return execFileSync("git", ["-C", dir, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}
function makeContext(ctx, scope, targetDir, item, scopeVars, sourceVars) {
  return {
    vars: { ...sourceVars, ...scopeVars },
    project: scope === "project" ? { dir: ctx.projectDir, name: basename(ctx.projectDir), git_remote: gitRemote(ctx.projectDir) } : void 0,
    scope,
    target: { dir: targetDir },
    host: ctx.host ?? { name: hostname(), os: platform() },
    user: ctx.user ?? { name: userInfo().username, home: ctx.home },
    item: { name: item.name, type: item.type, source: item.source }
  };
}
async function sync(ctx, opts = {}) {
  const state = new State(ctx.stateRoot);
  return state.withLock(() => syncInner(ctx, opts, state));
}
async function syncInner(ctx, opts, state) {
  let config;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { scopes: [], error: err.message };
  }
  const sel = opts.scope ?? "all";
  const report = { scopes: [] };
  if (sel === "user" || sel === "all") {
    report.scopes.push(await syncScope(ctx, config, config.user, "user", opts, state));
  }
  if ((sel === "project" || sel === "all") && config.project) {
    report.scopes.push(await syncScope(ctx, config, config.project, "project", opts, state));
  }
  return report;
}
async function syncScope(ctx, config, scopeCfg, scope, opts, state) {
  const rep = emptyScopeReport(scope);
  const targetDir = targetDirOf(ctx, scope);
  const cacheRoot = cacheRootOf(ctx);
  const lockPath = join11(targetDir, "skilletor.lock.json");
  const oldLock = readLock(lockPath);
  const needed = [...new Set(scopeCfg.install.map((i) => i.source))];
  const resolved = /* @__PURE__ */ new Map();
  await Promise.all(
    needed.map(async (name) => {
      const src = config.sources.get(name);
      if (!src) {
        rep.warnings.push(`unknown source: ${name}`);
        resolved.set(name, null);
        return;
      }
      if (!state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) {
        rep.trustRequests.push({ name, url: identityOf(src) });
        resolved.set(name, null);
        return;
      }
      try {
        const loc = await makeBackend(src, ctx.home, cacheRoot).resolve(sourceVersion(oldLock, name));
        if (loc.warning) rep.warnings.push(loc.warning);
        resolved.set(name, { dir: loc.dir, version: loc.version });
      } catch (err) {
        rep.warnings.push(`source ${name}: ${err.message}`);
        resolved.set(name, null);
      }
    })
  );
  const plan = [];
  const keep = [];
  const catalogs = /* @__PURE__ */ new Map();
  const keyInfo = /* @__PURE__ */ new Map();
  for (const item of scopeCfg.install) {
    keyInfo.set(item.target, { key: item.target, type: item.type, name: item.name, source: item.source });
    const r = resolved.get(item.source);
    const keepIfLocked = () => {
      if (item.target in oldLock) keep.push(item.target);
    };
    if (!r) {
      keepIfLocked();
      continue;
    }
    let cat = catalogs.get(item.source);
    if (!cat) {
      try {
        cat = scan(r.dir);
        catalogs.set(item.source, cat);
      } catch (err) {
        rep.warnings.push(`source ${item.source}: ${err.message}`);
        keepIfLocked();
        continue;
      }
    }
    const catItem = cat.items.find((ci) => ci.type === item.type && ci.name === item.name);
    if (!catItem) {
      rep.warnings.push(`item not found in source ${item.source}: ${item.type} ${item.name}`);
      keepIfLocked();
      continue;
    }
    let output;
    try {
      output = build(catItem, r.dir, makeContext(ctx, scope, targetDir, item, scopeCfg.vars, cat.meta.vars ?? {}));
    } catch (err) {
      rep.warnings.push(`template error in ${item.type} ${item.name}: ${err.message}`);
      keepIfLocked();
      continue;
    }
    plan.push({ key: item.target, type: item.type, name: item.name, source: item.source, version: r.version, output });
  }
  const result = apply(plan, { targetDir, force: opts.force, keep });
  if (scope === "project") {
    const newLock = readLock(lockPath);
    const managed = Object.values(newLock).flatMap((e) => Object.keys(e.files));
    updateGitignore({ claudeDir: targetDir, managedPaths: managed, enabled: scopeCfg.gitignore !== false });
  }
  const toChange = (key) => keyInfo.get(key) ?? { key, ...keyToTypeName(key), source: oldLock[key]?.source ?? "?" };
  rep.added = result.added.map(toChange);
  rep.updated = result.updated.map(toChange);
  rep.removed = result.removed.map(toChange);
  rep.unchanged = result.unchanged.map(toChange);
  rep.conflicts = result.conflicts.map((c) => ({ path: c.path }));
  rep.overwritten = result.overwritten.map((c) => ({ path: c.path }));
  return rep;
}
async function check(ctx, opts = {}) {
  let config;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { changed: false, sources: [], warnings: [], error: err.message };
  }
  const state = new State(ctx.stateRoot);
  const cacheRoot = cacheRootOf(ctx);
  const sel = opts.scope ?? "all";
  const out = { changed: false, sources: [], warnings: [] };
  const scopes = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);
  for (const [scope, scopeCfg] of scopes) {
    const oldLock = readLock(join11(targetDirOf(ctx, scope), "skilletor.lock.json"));
    for (const name of new Set(scopeCfg.install.map((i) => i.source))) {
      const src = config.sources.get(name);
      if (!src || !state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) continue;
      try {
        const changed = await makeBackend(src, ctx.home, cacheRoot).check(sourceVersion(oldLock, name));
        out.sources.push({ name, scope, changed });
        if (changed) out.changed = true;
      } catch (err) {
        out.warnings.push(`source ${name}: ${err.message}`);
      }
    }
  }
  return out;
}
function status(ctx, opts = {}) {
  let config;
  try {
    config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  } catch (err) {
    return { scopes: [], error: err.message };
  }
  const state = new State(ctx.stateRoot);
  const sel = opts.scope ?? "all";
  const scopes = [];
  if (sel === "user" || sel === "all") scopes.push(["user", config.user]);
  if ((sel === "project" || sel === "all") && config.project) scopes.push(["project", config.project]);
  const out = { scopes: [] };
  for (const [scope, scopeCfg] of scopes) {
    const lock = readLock(join11(targetDirOf(ctx, scope), "skilletor.lock.json"));
    const declaredKeys = new Set(scopeCfg.install.map((i) => i.target));
    const sourceVersions = {};
    for (const entry of Object.values(lock)) sourceVersions[entry.source] = entry.version;
    const trustRequests = [];
    for (const name of new Set(scopeCfg.install.map((i) => i.source))) {
      const src = config.sources.get(name);
      if (src && !state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) {
        trustRequests.push({ name, url: identityOf(src) });
      }
    }
    out.scopes.push({
      scope,
      declared: scopeCfg.install.map((i) => ({ key: i.target, source: i.source, installed: i.target in lock })),
      orphans: Object.keys(lock).filter((k) => !declaredKeys.has(k)),
      trustRequests,
      sourceVersions
    });
  }
  return out;
}

// src/commands.ts
import { join as join12 } from "node:path";

// src/spec.ts
var SpecError = class extends Error {
  name = "SpecError";
};
var KNOWN_FORGES = ["github.com", "gitlab.com", "codeberg.org", "hf.co", "huggingface.co"];
var DEFAULT_REPO = "skills";
function normalizeName(raw) {
  return raw.toLowerCase().replace(/\.git$/, "").replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}
function basename2(path) {
  const parts = path.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
function isLocal(spec) {
  return spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../") || spec.startsWith("~");
}
function hasScheme(spec) {
  return /^[a-z][a-z0-9+.-]*:\/\//.test(spec);
}
function isScpLike(spec) {
  return /^[^@/]+@[^:/]+:/.test(spec);
}
function isTarball(url) {
  return url.endsWith(".tar.gz") || url.endsWith(".tgz");
}
function nameFromUrl(spec, kind) {
  if (isScpLike(spec)) {
    const path = spec.slice(spec.indexOf(":") + 1);
    return normalizeName(basename2(path.split("/")[0] ?? path));
  }
  try {
    const u = new URL(spec);
    const segs = u.pathname.split("/").filter(Boolean);
    if (kind === "git" && segs.length > 0) return normalizeName(segs[0]);
    return normalizeName(u.hostname);
  } catch {
    return normalizeName(spec);
  }
}
function resolveSpec(spec, probe) {
  const s = spec.trim();
  if (isLocal(s)) {
    return { kind: "local", value: s, derivedName: normalizeName(basename2(s)) };
  }
  if (hasScheme(s) || isScpLike(s)) {
    const kind = isTarball(s) ? "url" : "git";
    return { kind, value: s, derivedName: nameFromUrl(s, kind) };
  }
  if (s.startsWith("github:")) {
    const path2 = s.slice("github:".length);
    const [owner, repo] = path2.split("/");
    if (!owner) throw new SpecError(`cannot resolve "${spec}": expected github:owner[/repo]`);
    return {
      kind: "git",
      value: `https://github.com/${owner}/${repo ?? DEFAULT_REPO}`,
      derivedName: normalizeName(owner)
    };
  }
  const slash = s.indexOf("/");
  const firstSeg = slash === -1 ? s : s.slice(0, slash);
  const rest = slash === -1 ? "" : s.slice(slash + 1);
  if (KNOWN_FORGES.includes(firstSeg.toLowerCase()) && slash !== -1) {
    const segs = rest.split("/").filter(Boolean);
    const owner = segs[0];
    if (!owner) throw new SpecError(`cannot resolve "${spec}": expected ${firstSeg}/owner[/repo]`);
    const repo = segs[1] ?? DEFAULT_REPO;
    return {
      kind: "git",
      value: `https://${firstSeg.toLowerCase()}/${owner}/${repo}`,
      derivedName: normalizeName(owner)
    };
  }
  if (slash === -1) {
    if (!firstSeg.includes(".")) {
      return {
        kind: "git",
        value: `https://github.com/${firstSeg}/${DEFAULT_REPO}`,
        derivedName: normalizeName(firstSeg)
      };
    }
    return probeGeneric(`https://${firstSeg}/${DEFAULT_REPO}`, firstSeg, spec, probe);
  }
  if (!firstSeg.includes(".")) {
    const segs = rest.split("/").filter(Boolean);
    const repo = segs[0] ?? DEFAULT_REPO;
    return {
      kind: "git",
      value: `https://github.com/${firstSeg}/${repo}`,
      derivedName: normalizeName(firstSeg)
    };
  }
  const path = rest.replace(/\/+$/, "");
  const base = path ? `https://${firstSeg}/${path}` : `https://${firstSeg}/${DEFAULT_REPO}`;
  return probeGeneric(base, firstSeg, spec, probe);
}
function probeGeneric(baseUrl, host, original, probe) {
  const result = probe(baseUrl);
  if (result.git) {
    return { kind: "git", value: baseUrl, derivedName: normalizeName(host) };
  }
  if (result.tarball) {
    return { kind: "url", value: `${baseUrl}.tar.gz`, derivedName: normalizeName(host) };
  }
  throw new SpecError(
    `cannot resolve "${original}": neither ${baseUrl} (git) nor ${baseUrl}.tar.gz (tarball) responded`
  );
}

// src/probe.ts
import { execFileSync as execFileSync2 } from "node:child_process";
function makeProbe(timeoutMs = 5e3) {
  return (baseUrl) => {
    try {
      execFileSync2("git", ["ls-remote", baseUrl], {
        stdio: "ignore",
        timeout: timeoutMs,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }
      });
      return { git: true };
    } catch {
    }
    if (headOk(`${baseUrl}.tar.gz`, timeoutMs)) return { tarball: true };
    return {};
  };
}
function headOk(url, timeoutMs) {
  const script = `const c=new AbortController();const t=setTimeout(()=>c.abort(),${timeoutMs});fetch(${JSON.stringify(url)},{method:'HEAD',signal:c.signal}).then(r=>{clearTimeout(t);process.exit(r.ok?0:1)}).catch(()=>process.exit(1));`;
  try {
    execFileSync2(process.execPath, ["-e", script], { stdio: "ignore", timeout: timeoutMs + 1e3 });
    return true;
  } catch {
    return false;
  }
}

// src/commands.ts
var CommandError = class extends Error {
  name = "CommandError";
};
function configPath(ctx, project) {
  const root = project ? ctx.projectDir : ctx.home;
  return join12(root, ".claude", "skilletor.json");
}
var TYPE_DIR = { skill: "skills", agent: "agents", rule: "rules" };
async function cmdAdd(ctx, args) {
  const resolved = resolveSpec(args.spec, ctx.probe ?? makeProbe());
  const name = args.name ?? resolved.derivedName;
  const def = resolved.kind === "git" ? { git: resolved.value } : resolved.kind === "url" ? { url: resolved.value } : { local: resolved.value };
  addSource(configPath(ctx, Boolean(args.project)), name, def);
  new State(ctx.stateRoot).trust(name, resolved.value);
  const report = await sync(ctx);
  return { name, def, report };
}
function cmdSourceList(ctx) {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  return [...config.sources.values()].map((s) => ({
    name: s.name,
    def: pickDef(s),
    origin: s.origin
  }));
}
function pickDef(s) {
  const def = {};
  if (s.git) def.git = s.git;
  if (s.ref) def.ref = s.ref;
  if (s.url) def.url = s.url;
  if (s.local) def.local = s.local;
  return def;
}
async function cmdSourceRemove(ctx, args) {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const inUse = declaredItems(config).some((i) => i.source === args.name);
  if (inUse && !args.force) {
    throw new CommandError(`source "${args.name}" still has installed items; use --force to remove anyway`);
  }
  removeSource(configPath(ctx, Boolean(args.project)), args.name);
  return sync(ctx);
}
async function cmdAvailable(ctx, args = {}) {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const state = new State(ctx.stateRoot);
  const installedKeys = installedSet(ctx, config);
  const names = args.source ? [args.source] : [...config.sources.keys()];
  const out = [];
  for (const name of names) {
    const src = config.sources.get(name);
    if (!src) throw new CommandError(`unknown source: ${name}`);
    if (!state.isTrusted({ name, resolved: identityOf(src), origin: src.origin })) continue;
    const loc = await makeBackend(src, ctx.home, cacheRootOf(ctx)).resolve();
    for (const item of scan(loc.dir).items) {
      out.push({
        type: item.type,
        name: item.name,
        description: item.description,
        source: name,
        installed: installedKeys.has(`${TYPE_DIR[item.type]}/${item.name}@${name}`)
      });
    }
  }
  return out;
}
async function cmdInstall(ctx, args) {
  const path = configPath(ctx, Boolean(args.project));
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const state = new State(ctx.stateRoot);
  const catalogs = /* @__PURE__ */ new Map();
  for (const spec of args.items) {
    const { type: explicitType, name, source } = parseItemSpec(spec);
    const src = config.sources.get(source);
    if (!src) throw new CommandError(`unknown source: ${source}`);
    if (!state.isTrusted({ name: source, resolved: identityOf(src), origin: src.origin })) {
      throw new CommandError(`source "${source}" is not trusted; run: skilletor trust ${source}`);
    }
    let cat = catalogs.get(source);
    if (!cat) {
      cat = scan((await makeBackend(src, ctx.home, cacheRootOf(ctx)).resolve()).dir);
      catalogs.set(source, cat);
    }
    const matches = cat.items.filter((i) => i.name === name && (!explicitType || i.type === explicitType));
    if (matches.length === 0) {
      const suggestions = cat.items.map((i) => `${i.type}:${i.name}`).slice(0, 8).join(", ");
      throw new CommandError(`unknown item "${name}" in ${source}${suggestions ? ` (available: ${suggestions})` : ""}`);
    }
    if (matches.length > 1) {
      const types = matches.map((m) => `${m.type}:${name}@${source}`).join(", ");
      throw new CommandError(`"${name}" is ambiguous in ${source}; use one of: ${types}`);
    }
    addInstallEntry(path, matches[0].type, `${name}@${source}`);
  }
  return sync(ctx);
}
async function cmdUninstall(ctx, args) {
  const path = configPath(ctx, Boolean(args.project));
  for (const spec of args.items) {
    const { name, source } = parseItemSpec(spec);
    removeInstallEntries(path, name, source);
  }
  return sync(ctx);
}
function cmdTrust(ctx, args) {
  const config = loadConfig({ home: ctx.home, projectDir: ctx.projectDir });
  const src = config.sources.get(args.name);
  if (!src) throw new CommandError(`unknown source: ${args.name}`);
  const url = identityOf(src);
  new State(ctx.stateRoot).trust(args.name, url);
  return { name: args.name, url };
}
function parseItemSpec(spec) {
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) {
    throw new CommandError(`item "${spec}" must be name@source (or type:name@source)`);
  }
  const source = spec.slice(at + 1);
  let name = spec.slice(0, at);
  let type;
  const colon = name.indexOf(":");
  if (colon !== -1) {
    const prefix = name.slice(0, colon);
    if (prefix !== "skill" && prefix !== "agent" && prefix !== "rule") {
      throw new CommandError(`unknown type prefix "${prefix}" in "${spec}"`);
    }
    type = prefix;
    name = name.slice(colon + 1);
  }
  return { type, name, source };
}
function declaredItems(config) {
  const items = [...config.user.install];
  if (config.project) items.push(...config.project.install);
  return items.map((i) => ({ key: i.target, source: i.source }));
}
function installedSet(ctx, config) {
  const set = /* @__PURE__ */ new Set();
  for (const i of declaredItems(config)) set.add(`${i.key}@${i.source}`);
  for (const scope of ["user", "project"]) {
    const dir = join12(scope === "user" ? ctx.home : ctx.projectDir ?? "", ".claude");
    if (scope === "project" && !ctx.projectDir) continue;
    for (const [key, entry] of Object.entries(readLock(join12(dir, "skilletor.lock.json")))) {
      set.add(`${key}@${entry.source}`);
    }
  }
  return set;
}

// src/cli.ts
var VERSION = true ? "0.1.0" : "0.0.0-dev";
var USAGE = `skilletor ${VERSION}
Remote skills, agents and rules for Claude Code.

Usage:
  skilletor <command> [options]

Commands:
  sync                  Reconcile installed items with the config
  check                 Report whether any source has changed (writes nothing)
  status                Show declared vs. installed items
  add [name] <spec>     Add a source (coming soon)
  install <item>...     Install items (coming soon)
  uninstall <item>...   Remove items (coming soon)
  trust <source>        Trust a project-declared source (coming soon)

Options:
  --scope <s>           user | project | all (default: all)
  --json                Machine-readable output
  --force               Adopt foreign files on conflict
  --project-dir <dir>   Project root (default: cwd)
  -h, --help            Show this help
  -v, --version         Show the version
`;
function parseFlags(args) {
  const flags = { scope: "all", json: false, force: false, project: false, rest: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") flags.json = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--project") flags.project = true;
    else if (a === "--scope") flags.scope = args[++i];
    else if (a.startsWith("--scope=")) flags.scope = a.slice(8);
    else if (a === "--project-dir") flags.projectDir = args[++i];
    else if (a.startsWith("--project-dir=")) flags.projectDir = a.slice(14);
    else flags.rest.push(a);
  }
  return flags;
}
function makeContext2(flags) {
  const home = homedir();
  return {
    home,
    projectDir: flags.projectDir ?? process.cwd(),
    stateRoot: join13(home, ".claude", "skilletor")
  };
}
function statusText(report) {
  if (report.error) return `skilletor: config error \u2014 ${report.error}`;
  const lines = [];
  for (const s of report.scopes) {
    lines.push(`${s.scope} scope:`);
    for (const d of s.declared) lines.push(`  ${d.installed ? "\u2713" : "\xB7"} ${d.key} @${d.source}`);
    for (const o of s.orphans) lines.push(`  ? ${o} (in lock, not declared)`);
    for (const t of s.trustRequests) lines.push(`  trust: ${t.name} (${t.url})`);
  }
  return lines.join("\n");
}
async function run(argv) {
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  const cmd = argv[0];
  const flags = parseFlags(argv.slice(1));
  if (!["user", "project", "all"].includes(flags.scope)) {
    process.stderr.write(`skilletor: invalid --scope: ${flags.scope}
`);
    return 2;
  }
  const ctx = makeContext2(flags);
  try {
    switch (cmd) {
      case "sync": {
        const r = await sync(ctx, { scope: flags.scope, force: flags.force });
        if (r.error) {
          process.stderr.write((flags.json ? reportJson(r) : reportText(r)) + "\n");
          return 2;
        }
        const text = flags.json ? reportJson(r) : reportText(r);
        process.stdout.write((text || "skilletor: up to date") + "\n");
        return 0;
      }
      case "check": {
        const r = await check(ctx, { scope: flags.scope });
        if (r.error) {
          process.stderr.write(`skilletor: ${r.error}
`);
          return 2;
        }
        process.stdout.write(
          (flags.json ? JSON.stringify(r, null, 2) : r.changed ? "changed" : "up to date") + "\n"
        );
        return r.changed ? 1 : 0;
      }
      case "status": {
        const r = status(ctx, { scope: flags.scope });
        process.stdout.write((flags.json ? JSON.stringify(r, null, 2) : statusText(r)) + "\n");
        return r.error ? 2 : 0;
      }
      case "add": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: add needs a source spec\n");
          return 2;
        }
        const name = flags.rest.length >= 2 ? flags.rest[0] : void 0;
        const spec = flags.rest.length >= 2 ? flags.rest[1] : flags.rest[0];
        const r = await cmdAdd(ctx, { name, spec, project: flags.project });
        process.stdout.write(`added source ${r.name} (${JSON.stringify(r.def)})
`);
        process.stdout.write((reportText(r.report) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "source": {
        const sub = flags.rest[0];
        if (sub === "list") {
          const list = cmdSourceList(ctx);
          process.stdout.write(
            (flags.json ? JSON.stringify(list, null, 2) : list.map((s) => `${s.name} [${s.origin}] ${JSON.stringify(s.def)}`).join("\n")) + "\n"
          );
          return 0;
        }
        if (sub === "remove") {
          const name = flags.rest[1];
          if (!name) {
            process.stderr.write("skilletor: source remove needs a name\n");
            return 2;
          }
          const r = await cmdSourceRemove(ctx, { name, project: flags.project, force: flags.force });
          process.stdout.write((reportText(r) || `removed source ${name}`) + "\n");
          return 0;
        }
        process.stderr.write("skilletor: usage: source list | source remove <name>\n");
        return 2;
      }
      case "available": {
        const items = await cmdAvailable(ctx, { source: flags.rest[0] });
        if (flags.json) {
          process.stdout.write(JSON.stringify(items, null, 2) + "\n");
        } else {
          process.stdout.write(
            items.map((i) => `${i.installed ? "\u2713" : " "} ${i.type} ${i.name}@${i.source}${i.description ? ` \u2014 ${i.description}` : ""}`).join("\n") + "\n"
          );
        }
        return 0;
      }
      case "install": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: install needs at least one item\n");
          return 2;
        }
        const r = await cmdInstall(ctx, { items: flags.rest, project: flags.project });
        process.stdout.write((reportText(r) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "uninstall": {
        if (flags.rest.length === 0) {
          process.stderr.write("skilletor: uninstall needs at least one item\n");
          return 2;
        }
        const r = await cmdUninstall(ctx, { items: flags.rest, project: flags.project });
        process.stdout.write((reportText(r) || "skilletor: up to date") + "\n");
        return 0;
      }
      case "trust": {
        const name = flags.rest[0];
        if (!name) {
          process.stderr.write("skilletor: trust needs a source name\n");
          return 2;
        }
        const r = cmdTrust(ctx, { name });
        process.stdout.write(`trusted source ${r.name} (${r.url})
`);
        return 0;
      }
      default:
        process.stderr.write(`skilletor: unknown command: ${cmd}
`);
        return 2;
    }
  } catch (err) {
    process.stderr.write(`skilletor: ${err.message}
`);
    return 1;
  }
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`skilletor: ${err?.stack ?? err}
`);
      process.exit(1);
    }
  );
}
export {
  run
};
