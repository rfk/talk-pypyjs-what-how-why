//
//  PyPyJS:  an experimental in-browser python environment.
//

(function(exports) {

exports.PyPyJS = PyPyJS;

function PyPyJS(opts) {

  // Default stdin to a closed file.
  // Calling code may override this to handle stdin.
  this.stdin = function() {
    return null;
  }

  // Default stdout and stderr to /dev/null.
  // Calling code may override these to handle output.
  this.stdout = this.stderr = function(x) { }

  opts = opts || {};
  this.rootURL = opts.rootURL;
  this.totalMemory = opts.totalMemory || 128 * 1024 * 1024;
  this.autoLoadModules = opts.autoLoadModules || true;
  this._pendingModules = {};
  this._loadedModules = {};
  this._allModules = {};

  // Default to finding files relative to this very file.
  if (!this.rootURL && !PyPyJS.rootURL) {
    PyPyJS.rootURL = "./";
    // A little hackery to find the URL of this very file.
    // Throw an error, then parse the stack trace looking for filenames.
    var errlines = (new Error()).stack.split("\n");
    for (var i = 0; i < errlines.length; i++) {
      var match = /(https?:\/\/.+\/)pypy.js/.exec(errlines[i]);
      if (match) {
        PyPyJS.rootURL = match[1];
        break;
      }
    }
  }

  this.ready = new Promise((function(resolve, reject) {

    // Fetch the emscripten-compiled asmjs code.
    // We will need to eval() this in a scope with a custom 'Module' object.
    console.log("fetching asmjs code...");
    this.fetch("pypy.vm.js")
    .then((function(xhr) {

      // Initialize the Module object.
      var Module = {};
      Module.TOTAL_MEMORY = this.totalMemory;

      // We will set up the filesystem manually when we're ready.
      Module.noFSInit = true;
      Module.thisProgram = "/lib/pypyjs/pypy.js";
      Module.filePackagePrefixURL = this.rootURL || PyPyJS.rootURL;
      Module.memoryInitializerPrefixURL = this.rootURL || PyPyJS.rootURL;

      // Don't start or stop the program, just set it up.
      // We'll call the API functions ourself.
      Module.noInitialRun = true;
      Module.noExitRuntime = true;

      // Route stdout to an overridable method on the object.
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
 
      // Begin fetching the metadata for available python modules.
      //  With luck these can download while we jank around compiling
      //  all of tha javascript.
      //  XXX TODO: also load memory initialier this way.
      var moduleDataP = this.fetch("modules/index.json");

      // Eval the code.  This will probably take quite a while in Firefox
      // as it parses and compiles all the functions.  The result is that
      // our "Module" object is populated with all the exported VM functions.
      console.log("evaluating asmjs code...");
      eval(xhr.responseText);

      // Make the module available on this object.
      // We will use its methods to execute code in the VM.
      this._module = Module;

      // And some functions that are not exported by default.
      this._emjs_make_handle = _emjs_make_handle;
      this._emjs_free = _emjs_free;

      // This is where execution will continue after loading
      // the memory initialization data.
      var initializedResolve, initializedReject;
      var initializedP = new Promise(function(resolve, reject) {
          initializedResolve = resolve;
          initializedReject = reject;
      });
      dependenciesFulfilled = function() {
        // Initialize the VM state.
        try {
          console.log("initialising the vm...");
          FS.init(stdin, stdout, stderr);
          Module.FS_createPath("/", "lib/pypyjs/lib_pypy", true, false);
          Module.FS_createPath("/", "lib/pypyjs/lib-python/2.7", true, false);
          Module._rpython_startup_code();
          var pypy_home = Module.intArrayFromString("/lib/pypyjs/pypy.js");
          pypy_home = Module.allocate(pypy_home, 'i8', Module.ALLOC_NORMAL);
          Module._pypy_setup_home(pypy_home, 0);
          Module._free(pypy_home);
          var code = Module.intArrayFromString("import js");
          var code = Module.allocate(code, 'i8', Module.ALLOC_NORMAL);
          Module._pypy_execute_source(code);
          Module._free(code);
          initializedResolve();
        } catch (err) {
          initializedReject(err);
        }
      }
      if(!memoryInitializer) {
        dependenciesFulfilled();
      }
  
      return initializedP.then((function() {
        // Continue with processing the downloaded module metadata.
        return moduleDataP.then((function(xhr) {
          console.log("loading module index...");
          // Store the module index, and load any eager ones.
          var modIndex = JSON.parse(xhr.responseText);
          this._allModules = modIndex.modules;
          if (modIndex.eager) {
            for (var name in modIndex.eager) {
              console.log("loading eager module: " + name);
              this._writeModuleFile(name, modIndex.eager[name]);
            }
          }
          console.log("pypy.js is ready!");
        }).bind(this));
      }).bind(this))
    }).bind(this))
    .then(resolve, function(err){ console.log(err); reject(err)});

  }).bind(this));

};


// A simple file-fetching wrapper around XMLHttpRequest,
// that treats paths as relative to the pypy.js root url.
//
PyPyJS.prototype.fetch = function fetch(relpath, responseType) {
  return new Promise((function(resolve, reject) {
    var xhr = new XMLHttpRequest();
    xhr.onload = function() {
      console.log("loaded", relpath);
      if (xhr.status >= 400) {
        reject(xhr)
      } else {
        resolve(xhr);
      }
    };
    var rootURL = this.rootURL || PyPyJS.rootURL;
    xhr.open('GET', rootURL + relpath, true);
    xhr.responseType = responseType || "string";
    xhr.send(null);
  }).bind(this));
};


// Method to evaluate some python code.
//
// This passes the given python code to the VM for execution.
// It is not possible to directly access the result of the code, if any.
// Rather you should store it into a variable and then use the get() method.
//
// XXX TODO: maybe we should throw an error if there's an error?
//
PyPyJS.prototype.eval = function eval(code) {

  var Module = this._module

  var p = Promise.resolve();
  // Find any "import" statements in the code,
  // and ensure the modules are ready for loading.
  if (this.autoLoadModules) {
    p = p.then((function() {
      return this.findImportedNames(code);
    }).bind(this))
    .then((function(imports) {
      return this.loadModuleData.apply(this, imports);
    }).bind(this))
  }
  // Now we can execute the code using the PyPy embedding API.
  p = p.then((function() {
    var code_chars = Module.intArrayFromString(code);
    var code_ptr = Module.allocate(code_chars, 'i8', Module.ALLOC_NORMAL);
    if (!code_ptr) {
      return -1;
    }
    var res = Module._pypy_execute_source(code_ptr);
    Module._free(code_ptr);
    return res;
  }).bind(this));
  return p;
}


// Method to read a python variable.
//
// This tries to convert the value in the named python variable into an
// equivalent javascript value and returns it.  It will fail if the variable
// does not exist or contains a value that cannot be converted.
//
// XXX TODO: maybe we should throw an error if there's an error?
//
PyPyJS._resultsID = 0;
PyPyJS._resultsMap = {};
PyPyJS.prototype.get = function get(name) {
  var Module = this._module
  var resid = ""+(PyPyJS._resultsID++);
  return new Promise((function(resolve, reject) {
    name = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    var code = "globals()['" + name + "']";
    code = "js.convert(" + code + ")"
    code = "js.globals['PyPyJS']._resultsMap['" + resid + "'] = " + code;
    var code_chars = Module.intArrayFromString(code);
    var code_ptr = Module.allocate(code_chars, 'i8', Module.ALLOC_NORMAL);
    if (!code_ptr) {
      reject("failed to allocate code string");
    }
    var res = Module._pypy_execute_source(code_ptr);
    Module._free(code_ptr);
    if (res !== 0) {
      reject("error executing code");
    } else {
      resolve(PyPyJS._resultsMap[resid]);
      delete PyPyJS._resultsMap[resid];
    }
  }).bind(this));
}


// Method to set a python variable to a javascript value.
//
// This generates a handle to the given object, and arranges for the named
// python variable to reference it via that handle.
//
PyPyJS.prototype.set = function set(name, value) {
  var Module = this._module
  return new Promise((function(resolve, reject) {
    var h = this._emjs_make_handle(value);
    name = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
    // XXX TODO: need to expose _wrap_handle to python code somehow.
    var code = "globals()['" + name + "'] = js.Value(" + h + ")";
    var code_chars = Module.intArrayFromString(code);
    var code_ptr = Module.allocate(code_chars, 'i8', Module.ALLOC_NORMAL);
    if (!code_ptr) {
      this._emjs_free(h);
      reject("failed to allocate code string");
    }
    var res = Module._pypy_execute_source(code_ptr);
    Module._free(code_ptr);
    if (res !== 0) {
      this._emjs_free(h);
      reject("error executing code");
    } else {
      resolve();
    }
  }).bind(this));
}

// Method to look for "import" statements in a code string.
// Returns a promise that will resolve to a list of imported module names.
//
// XXX TODO: this is far from complete and should not be done with a regex.
// Perhaps we can call into python's "ast" module for this parsing?
//
var importStatementRE = /(from\s+([a-zA-Z0-9_\.]+)\s+)?import\s+\(?\s*([a-zA-Z0-9_\.\*]+(\s+as\s+[a-zA-Z0-9_]+)?\s*,?\s*)+\s*\)?/g
PyPyJS.prototype.findImportedNames = function findImportedNames(code) {
  var match = null;
  var imports = [];
  importStatementRE.lastIndex = 0;
  while ((match = importStatementRE.exec(code)) !== null) {
    var relmod = match[2];
    if (relmod) {
      relmod = relmod + ".";
    } else {
      relmod = "";
    }
    var submods = match[0].split("import")[1];
    while (submods && /[\s(]/.test(submods.charAt(0))) {
      submods = submods.substr(1);
    }
    while (submods && /[\s)]/.test(submods.charAt(submods.length - 1))) {
      submods = submods.substr(0, submods.length - 1);
    }
    submods = submods.split(/\s*,\s*/);
    for (var i = 0; i < submods.length; i++) {
      var submod = submods[i];
      submod = submod.split(/\s*as\s*/)[0];
      imports.push(relmod + submod);
    }
  }
  return Promise.resolve(imports);
}


// Method to load the contents of a python module, along with
// any dependencies.  This populates the relevant paths within
// the VMs simulated filesystem so that is can find and import
// the specified module.
//
PyPyJS.prototype.loadModuleData = function loadModuleData(/* names */) {
  // Each argument is a name that we want to import.
  // We must find the longest prefix that is an available module
  // and load it along with all its dependencies.
  var toLoad = {};
  NEXTNAME: for (var i = 0; i < arguments.length; i++) {
    var name = arguments[i];
    // Find the nearest containing module for the given name.
    // Note that it may not match a module at all, in which case we ignore it.
    while (true) {
      if (this._allModules[name]) {
        break;
      }
      name = name.substr(0, name.lastIndexOf("."));
      if (!name) continue NEXTNAME;
    }
    this._findModuleDeps(name, toLoad);
  } 
  // Now ensure that each module gets loaded.
  var p = Promise.resolve();
  for (var name in toLoad) {
    p = p.then(this._makeLoadModuleData(name));
  }
  return p;
}


PyPyJS.prototype._findModuleDeps = function _findModuleDeps(name, seen) {
  if (!seen) seen = {};
  var deps = [];
  // If we don't know about this module, ignore it.
  if (!this._allModules[name]) {
    return seen;
  }
  // Depend on any explicitly-named imports.
  var imports = this._allModules[name].imports;
  if (imports) {
    for (var i = 0; i < imports.length; i++) {
      deps.push(imports[i]);
    }
  }
  // Depend on the __init__.py for packages.
  if (this._allModules[name].dir) {
    deps.push(name + ".__init__");
  }
  // Include the parent package, if any.
  var idx = name.lastIndexOf(".");
  if (idx !== -1) {
    deps.push(name.substr(0, idx));
  }
  // Recurse for any previously-unseen dependencies.
  seen[name] = true;
  for (var i = 0; i < deps.length; i++) {
    if (!seen[deps[i]]) {
      this._findModuleDeps(deps[i], seen);
    }
  }
  return seen;
}


PyPyJS.prototype._makeLoadModuleData = function _makeLoadModuleData(name) {
  return (function() {
    // If we've already loaded this module, we're done.
    if (this._loadedModules[name]) {
      return Promise.resolve();
    }
    // If we're already in the process of loading it, use the existing promise.
    if (this._pendingModules[name]) {
      return this._pendingModules[name];
    }
    // If it's a package directory, there's not actually anything to do.
    if (this._allModules[name].dir) {
      return Promise.resolve();
    }
    // We need to fetch the module file and write it out.
    var modfile = this._allModules[name].file;
    var p = this.fetch("modules/" + modfile)
    .then((function(xhr) {
      var contents = xhr.responseText;
      this._writeModuleFile(name, contents)
      delete this._pendingModules[name];
    }).bind(this))
    this._pendingModules[name] = p;
    return p;
  }).bind(this);
}


PyPyJS.prototype._writeModuleFile = function _writeModuleFile(name, data) {
  var Module = this._module;
  var file = this._allModules[name].file;
  // Create the containing directory first.
  var dir = file.split("/").slice(0, -1).join("/")
  try {
    Module.FS_createPath("/lib/pypyjs/lib_pypy", dir, true, false);
  } catch (e) { }
  // Now we can safely create the file.
  var fullpath = "/lib/pypyjs/lib_pypy/" + file;
  console.log("  created file", fullpath)
  Module.FS_createDataFile(fullpath, "", data, true, false, true);
  this._loadedModules[name] = true;
}


// XXX TODO: expose the filesystem for manipulation by calling code.

})(window);
