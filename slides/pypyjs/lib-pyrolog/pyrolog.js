//
//  PyrologJS:  an experimental in-browser prolog environment.
//

(function() {

// Expose the main PyrologJS function at global scope for this file,
// as well as in any module exports or 'window' object we can find.
if (this) {
  this.PyrologJS = PyrologJS;
}
if (typeof window !== "undefined") {
  window.PyrologJS = PyrologJS;
}
if (typeof module !== "undefined") {
  if (typeof module.exports !== "undefined") {
    module.exports = PyrologJS;
  }
}


// Generic debugging printf.
var debug = function(){};
if (typeof console !== "undefined") {
  debug = console.log;
} else if (typeof print !== "undefined") {
  debug = print
}


// Find the directory containing this very file.
// It can be quite difficult depending on execution environment...
if (typeof __dirname === "undefined") {
  var __dirname = "./";
  // A little hackery to find the URL of this very file.
  // Throw an error, then parse the stack trace looking for filenames.
  var errlines = (new Error()).stack.split("\n");
  for (var i = 0; i < errlines.length; i++) {
    var match = /(at |@)(.+\/)pyrolog.js/.exec(errlines[i]);
    if (match) {
      __dirname = match[2];
      break;
    }
  }
}
if (__dirname.charAt(__dirname.length - 1) !== "/") {
  __dirname += "/";
} 


// Ensure we have reference to a 'Promise' constructor.
var Promise;
if (typeof Promise === "undefined") {
  if (this && typeof this.Promise !== "undefined") {
    Promise = this.Promise;
  } else if (typeof require === "function") {
    Promise = require("./Promise.min.js");
  } else if (typeof load === "function") {
    load(__dirname + "Promise.min.js");
    if (typeof Promise === "undefined") {
      if (this && typeof this.Promise !== "undefined") {
        Promise = this.Promise;
      }
    }
  } else if (typeof window !== "undefined") {
    if (typeof window.Promise !== "undefined") {
      var Promise = window.Promise;
    }
  }
}

if (typeof Promise === "undefined") {
  throw "Promise object not found";
}

// Some extra goodies for nodejs.
if (typeof require === "function") {
  var fs = require("fs");
  var path = require("path");
}


// Main class representing the Pyrolog VM.
// This is our primary export and return value.
function PyrologJS(opts) {

  // Default stdin to a closed file.
  // Calling code may override this to handle stdin.
  this.stdin = function() {
    return null;
  }

  // Default stdout and stderr to process outputs if available, otherwise
  // to /dev/null. Calling code may override these to handle output.
  this.stdout = this.stderr = null
  if (typeof process !== "undefined") {
    if (typeof process.stdout !== "undefined") {
      this.stdout = function(x) { process.stdout.write(x); }
    }
    if (typeof process.stderr !== "undefined") {
      this.stderr = function(x) { process.stderr.write(x); }
    }
  }
  if (typeof print !== "undefined") {
    if (this.stdout === null) {
      // print() will add a newline, so we buffer until we
      // receive one and then let it add it for us.
      this.stdout = (function() {
        var buffer = [];
        return function(data) {
          for (var i = 0; i < data.length; i++) {
            var x = data.charAt(i);
            if (x !== "\n") {
              buffer.push(x);
            } else {
              print(buffer.join(""));
              buffer.splice(undefined, buffer.length);
            }
          }
        }
      })();
    }
  }
  if (typeof printErr !== "undefined") {
    if (this.stderr === null) {
      // printErr() will add a newline, so we buffer until we
      // receive one and then let it add it for us.
      this.stderr = (function() {
        var buffer = [];
        return function(data) {
          for (var i = 0; i < data.length; i++) {
            var x = data.charAt(i);
            if (x !== "\n") {
              buffer.push(x);
            } else {
              printErr(buffer.join(""));
              buffer.splice(undefined, buffer.length);
            }
          }
        }
      })();
    }
  }
  if (this.stdout === null) {
    this.stdout = function(x) {};
  }
  if (this.stderr === null) {
    this.stderr = this.stdout;
  }

  opts = opts || {};
  this.rootURL = opts.rootURL;
  this.totalMemory = opts.totalMemory || 128 * 1024 * 1024;

  // Default to finding files relative to this very file.
  if (!this.rootURL && !PyrologJS.rootURL) {
    PyrologJS.rootURL = __dirname;
  }
  if (this.rootURL && this.rootURL.charAt(this.rootURL.length - 1) !== "/") {
    this.rootURL += "/";
  } 

  this.ready = new Promise((function(resolve, reject) {

    // Fetch the emscripten-compiled asmjs code.
    // We will need to eval() this in a scope with a custom 'Module' object.
    this.fetch("pyrolog.vm.js")
    .then((function(xhr) {

      // Initialize the Module object.
      var Module = {};
      Module.TOTAL_MEMORY = this.totalMemory;

      // We will set up the filesystem manually when we're ready.
      Module.noFSInit = true;
      Module.thisProgram = "/lib/pypyjs/pyrolog.js";
      Module.filePackagePrefixURL = this.rootURL || PyrologJS.rootURL;
      Module.memoryInitializerPrefixURL = this.rootURL || PyrologJS.rootURL;
      Module.locateFile = function(name) {
        return (this.rootURL || PyrologJS.rootURL) + name;
      }

      // Don't start or stop the program, just set it up.
      // We'll call the API functions ourself.
      Module.noInitialRun = true;
      Module.noExitRuntime = true;

      // Route stdin to an overridable method on the object.
      var stdin = (function stdin() {
        return this.stdin();
      }).bind(this);
 
      // Route stdout to an overridable method on the object.
      // We buffer the output for efficiency.
      var stdout_buffer = []
      var stdout = (function stdout(x) {
        var c = String.fromCharCode(x);
        stdout_buffer.push(c);
        if (c === "\n" || stdout_buffer.length >= 128) {
          this.stdout(stdout_buffer.join(""));
          stdout_buffer = [];
        }
      }).bind(this);

      // Route stderr to an overridable method on the object.
      // We do not buffer stderr.
      var stderr = (function stderr(x) {
        var c = String.fromCharCode(x);
        this.stderr(c);
      }).bind(this);
 
      // Eval the code.  This will probably take quite a while in Firefox
      // as it parses and compiles all the functions.  The result is that
      // our "Module" object is populated with all the exported VM functions.
      eval(xhr.responseText);

      // Make the module available on this object.
      // We will use its methods to execute code in the VM.
      this._module = Module;

      // Ensure that some functions are available on the Module,
      // for linking with jitted code.
      if (!Module._jitInvoke && typeof _jitInvoke !== "undefined") {
        Module._jitInvoke = _jitInvoke;
      }

      // This is where execution will continue after loading
      // the memory initialization data.
      var initializedResolve, initializedReject;
      var initializedP = new Promise(function(resolve, reject) {
          initializedResolve = resolve;
          initializedReject = reject;
      });
      dependenciesFulfilled = function() {
        // Initialize the filesystem state.
        try {
          FS.init(stdin, stdout, stderr);
          initializedResolve();
        } catch (err) {
          initializedReject(err);
        }
      }
      if(!memoryInitializer) {
        dependenciesFulfilled();
      } else if(!ENVIRONMENT_IS_WEB && !ENVIRONMENT_IS_WORKER) {
        dependenciesFulfilled();
      }
  
      return initializedP.then((function() {
        Module._rpython_startup_code();
      }).bind(this))
    }).bind(this))
    .then(resolve, function(err){ debug("ERROR: " + err); reject(err) });
  }).bind(this));

};


// A simple file-fetching wrapper around XMLHttpRequest,
// that treats paths as relative to the pyrolog.js root url.
//
PyrologJS.prototype.fetch = function fetch(relpath, responseType) {
  // For the web, use XMLHttpRequest.
  if (typeof XMLHttpRequest !== "undefined") {
    return new Promise((function(resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.onload = function() {
        if (xhr.status >= 400) {
          reject(xhr)
        } else {
          resolve(xhr);
        }
      };
      var rootURL = this.rootURL || PyrologJS.rootURL;
      xhr.open('GET', rootURL + relpath, true);
      xhr.responseType = responseType || "string";
      xhr.send(null);
    }).bind(this));
  }
  // For nodejs, use fs.readFile.
  if (typeof fs !== "undefined" && typeof fs.readFile !== "undefined") {
    return new Promise((function(resolve, reject) {
      var rootURL = this.rootURL || PyrologJS.rootURL;
      fs.readFile(path.join(rootURL, relpath), function(err, data) {
        if (err) return reject(err);
        resolve({ responseText: data.toString() });
      });
    }).bind(this));
  }
  // For spidermonkey, use snarf (which has a binary read mode).
  if (typeof snarf !== "undefined") {
    return new Promise((function(resolve, reject) {
      var rootURL = this.rootURL || PyrologJS.rootURL;
      var data = snarf(rootURL + relpath);
      resolve({ responseText: data });
    }).bind(this));
  }
  // For d8, use read() and readbuffer().
  if (typeof read !== "undefined" && typeof readbuffer !== "undefined") {
    return new Promise((function(resolve, reject) {
      var rootURL = this.rootURL || PyrologJS.rootURL;
      var data = read(rootURL + relpath);
      resolve({ responseText: data });
    }).bind(this));
  }
  return new Promise(function(resolve, reject) {
    reject("unable to fetch files");
  });
};


// Method to evaluate some prolog code.
//
// This passes the given prolog code to the VM for execution.
// It is not possible to directly access the result of the code, if any.
// XXX TODO: we need equivalent of pypy.js "js" utility module.
// XXX TODO: maybe we should throw an error if there's an error?
//
PyrologJS.prototype.eval = function eval(code) {
  return this.ready.then((function() {
    var Module = this._module;
    var p = Promise.resolve();
    p = p.then((function() {
      var code_chars = Module.intArrayFromString(code);
      var code_ptr = Module.allocate(code_chars, 'i8', Module.ALLOC_NORMAL);
      if (!code_ptr) {
        return -1;
      }
      var res = Module._pyrolog_async_execute_input(code_ptr);
      Module._free(code_ptr);
      return res;
    }).bind(this));
    return p;
  }).bind(this));
}

// XXX TODO: expose the filesystem for manipulation by calling code.

return PyrologJS;

})();
