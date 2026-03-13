// Executes a WebAssembly binary produced by WasmCompiler.
//
// Provides the JavaScript import functions that the WASM module expects
// (write_i32, write_f64, write_str, writeln_finish, write_bool) and routes
// output to the same callbacks used by Machine.js, making the two backends
// interchangeable from the IDE's perspective.

'use strict';

define([], function () {

    var WasmMachine = function (wasmBytes) {
        // The compiled WASM binary (Uint8Array).
        this.wasmBytes = wasmBytes;

        // Called with a string whenever a line of output is produced.
        this.outputCallback = null;

        // Called when the program finishes, with the elapsed time in seconds.
        this.finishCallback = null;

        // Accumulates the current output line.
        this._lineBuffer = [];

        // Whether the program has been asked to run.
        this._running = false;
    };

    WasmMachine.prototype.setOutputCallback = function (cb) {
        this.outputCallback = cb;
    };

    WasmMachine.prototype.setFinishCallback = function (cb) {
        this.finishCallback = cb;
    };

    // Run the WASM program.  Returns a Promise that resolves when the program
    // finishes.
    WasmMachine.prototype.run = function () {
        var self = this;
        var startTime = Date.now();

        // Build the import object expected by WasmCompiler.
        var env = this._buildImports();

        return WebAssembly.instantiate(this.wasmBytes, { env: env })
            .then(function (result) {
                var exports = result.instance.exports;

                // Store a reference to the linear memory (for write_str).
                self._memory = exports.memory || null;

                // Call the entry point.
                exports.__main__();

                var elapsed = (Date.now() - startTime) / 1000;
                if (self.finishCallback) {
                    self.finishCallback(elapsed);
                }
            });
    };

    // Build the JS import functions that the WASM module calls.
    WasmMachine.prototype._buildImports = function () {
        var self = this;

        return {
            // Write an integer value to the current line.
            write_i32: function (v) {
                self._lineBuffer.push("" + v);
            },

            // Write a real value to the current line.
            write_f64: function (v) {
                // Match Turbo Pascal's numeric formatting: show integer values
                // without a decimal point for readability.
                var s;
                if (v === Math.floor(v) && Math.abs(v) < 1e15) {
                    s = "" + v;
                } else {
                    s = "" + v;
                }
                self._lineBuffer.push(s);
            },

            // Write a UTF-8 string slice from linear memory.
            write_str: function (ptr, len) {
                if (!self._memory) { return; }
                var mem = new Uint8Array(self._memory.buffer);
                var s = "";
                for (var i = 0; i < len; i++) {
                    s += String.fromCharCode(mem[ptr + i]);
                }
                self._lineBuffer.push(s);
            },

            // Finish the current line and send it to the output callback.
            writeln_finish: function () {
                var line = self._lineBuffer.join(" ");
                self._lineBuffer = [];
                if (self.outputCallback) {
                    self.outputCallback(line);
                }
            },

            // Write a boolean value.
            write_bool: function (v) {
                self._lineBuffer.push(v ? "TRUE" : "FALSE");
            },

            // Math helpers (called by native function calls in WasmCompiler).
            math_sin:   function (x) { return Math.sin(x); },
            math_cos:   function (x) { return Math.cos(x); },
            math_sqrt:  function (x) { return Math.sqrt(x); },
            math_abs:   function (x) { return Math.abs(x); },
            math_sqr:   function (x) { return x * x; },
            math_ln:    function (x) { return Math.log(x); },
            math_round: function (x) { return Math.round(x); },
            math_trunc: function (x) { return x < 0 ? Math.ceil(x) : Math.floor(x); }
        };
    };

    return WasmMachine;
});
