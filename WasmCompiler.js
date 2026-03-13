// Compiler from parse tree to WebAssembly binary format.
//
// Generates a WASM module that can be instantiated with WebAssembly.instantiate().
// Supports: Integer, Real, Boolean, Char types; global and local variables;
// arithmetic, comparison, and boolean expressions; if/else, while, for, repeat
// control flow; user-defined functions and procedures; WriteLn/Write output.

'use strict';

define(["Node", "inst", "PascalError"], function (Node, inst, PascalError) {

    // -----------------------------------------------------------------------
    // WASM binary encoding helpers
    // -----------------------------------------------------------------------

    // WASM value types.
    var WASM_I32 = 0x7F;
    var WASM_F64 = 0x7C;
    var WASM_VOID = 0x40; // empty/void block type

    // WASM section IDs.
    var SEC_TYPE     = 1;
    var SEC_IMPORT   = 2;
    var SEC_FUNCTION = 3;
    var SEC_MEMORY   = 5;
    var SEC_GLOBAL   = 6;
    var SEC_EXPORT   = 7;
    var SEC_CODE     = 10;
    var SEC_DATA     = 11;

    // WASM opcodes.
    var OP_UNREACHABLE   = 0x00;
    var OP_BLOCK         = 0x02;
    var OP_LOOP          = 0x03;
    var OP_IF            = 0x04;
    var OP_ELSE          = 0x05;
    var OP_END           = 0x0B;
    var OP_BR            = 0x0C;
    var OP_BR_IF         = 0x0D;
    var OP_RETURN        = 0x0F;
    var OP_CALL          = 0x10;
    var OP_DROP          = 0x1A;
    var OP_LOCAL_GET     = 0x20;
    var OP_LOCAL_SET     = 0x21;
    var OP_LOCAL_TEE     = 0x22;
    var OP_GLOBAL_GET    = 0x23;
    var OP_GLOBAL_SET    = 0x24;
    var OP_I32_CONST     = 0x41;
    var OP_F64_CONST     = 0x44;
    var OP_I32_EQZ       = 0x45;
    var OP_I32_EQ        = 0x46;
    var OP_I32_NE        = 0x47;
    var OP_I32_LT_S      = 0x48;
    var OP_I32_GT_S      = 0x4A;
    var OP_I32_LE_S      = 0x4C;
    var OP_I32_GE_S      = 0x4E;
    var OP_F64_EQ        = 0x61;
    var OP_F64_NE        = 0x62;
    var OP_F64_LT        = 0x63;
    var OP_F64_GT        = 0x64;
    var OP_F64_LE        = 0x65;
    var OP_F64_GE        = 0x66;
    var OP_I32_ADD       = 0x6A;
    var OP_I32_SUB       = 0x6B;
    var OP_I32_MUL       = 0x6C;
    var OP_I32_DIV_S     = 0x6D;
    var OP_I32_REM_S     = 0x6F;
    var OP_I32_AND       = 0x71;
    var OP_I32_OR        = 0x72;
    var OP_I32_XOR       = 0x73;
    var OP_F64_ABS       = 0x99;
    var OP_F64_SQRT      = 0x9F;
    var OP_F64_ADD       = 0xA0;
    var OP_F64_SUB       = 0xA1;
    var OP_F64_MUL       = 0xA2;
    var OP_F64_DIV       = 0xA3;
    var OP_F64_NEG       = 0x9A;
    var OP_I32_TRUNC_F64_S = 0xAA;
    var OP_F64_CONVERT_I32_S = 0xB7;

    // Encode an unsigned integer as LEB128.
    function uleb128(v) {
        var out = [];
        do {
            var b = v & 0x7F;
            v >>>= 7;
            if (v !== 0) { b |= 0x80; }
            out.push(b);
        } while (v !== 0);
        return out;
    }

    // Encode a signed integer as LEB128.
    function sleb128(v) {
        var out = [];
        var more = true;
        while (more) {
            var b = v & 0x7F;
            v >>= 7;
            if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
                more = false;
            } else {
                b |= 0x80;
            }
            out.push(b);
        }
        return out;
    }

    // Encode a float64 as 8 little-endian bytes.
    function encF64(v) {
        var buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, v, true);
        return Array.from(new Uint8Array(buf));
    }

    // Encode a string as a WASM name (uleb128 length + UTF-8 bytes).
    function encStr(s) {
        var bytes = [];
        for (var i = 0; i < s.length; i++) {
            bytes.push(s.charCodeAt(i) & 0xFF);
        }
        return uleb128(bytes.length).concat(bytes);
    }

    // Concatenate multiple byte arrays into one.
    function concat(arrays) {
        var total = 0;
        for (var ai = 0; ai < arrays.length; ai++) { total += arrays[ai].length; }
        var out = new Array(total);
        var pos = 0;
        for (var ai = 0; ai < arrays.length; ai++) {
            for (var bi = 0; bi < arrays[ai].length; bi++) {
                out[pos++] = arrays[ai][bi];
            }
        }
        return out;
    }

    // Wrap content in a WASM section with the given ID.
    function section(id, content) {
        return [id].concat(uleb128(content.length)).concat(content);
    }

    // -----------------------------------------------------------------------
    // Convert Pascal type to WASM type
    // -----------------------------------------------------------------------

    function pascalTypeToWasm(pascalType) {
        if (!pascalType || pascalType.nodeType !== Node.SIMPLE_TYPE) {
            return WASM_I32; // default
        }
        switch (pascalType.typeCode) {
            case inst.R:
                return WASM_F64;
            case inst.I:
            case inst.B:
            case inst.C:
            case inst.A:
                return WASM_I32;
            default:
                return WASM_I32;
        }
    }

    // -----------------------------------------------------------------------
    // WasmCompiler
    // -----------------------------------------------------------------------

    var WasmCompiler = function () {
        // Counter for generating unique local variable names.
        this._localCounter = 0;

        // Type section: list of {params: [...], results: [...]}
        this.types = [];
        this.typeMap = {}; // JSON key → index

        // Import section: list of {module, name, typeIdx}
        this.imports = [];

        // Named map of imports by name → funcIdx
        this.importFuncMap = {};

        // User-defined functions: list of {typeIdx, func: WasmFunc}
        this.userFuncs = [];

        // Map from normalized Pascal procedure/function name → absolute func index.
        // Absolute index = importCount + position in userFuncs.
        this.funcIndexMap = {};

        // Global section: list of {wasmType, initVal (number)}
        this.globals = [];

        // Map from normalized variable name (for program-level vars) → global index.
        this.globalMap = {};

        // String data for the data section: list of {offset, bytes}
        this.dataSegments = [];
        this.stringMap = {}; // string content → {offset, length}
        this.nextDataOffset = 0;

        // Whether we need a memory section.
        this.needsMemory = false;

        // The index (in userFuncs) of the main function.
        this.mainFuncUserIdx = -1;
    };

    // Return or create a type index for the given signature.
    WasmCompiler.prototype._typeIndex = function (params, results) {
        var key = JSON.stringify([params, results]);
        if (!this.typeMap.hasOwnProperty(key)) {
            this.typeMap[key] = this.types.length;
            this.types.push({ params: params, results: results });
        }
        return this.typeMap[key];
    };

    // Add an import and return its function index.
    WasmCompiler.prototype._addImport = function (module, name, params, results) {
        var typeIdx = this._typeIndex(params, results);
        var funcIdx = this.imports.length;
        this.imports.push({ module: module, name: name, typeIdx: typeIdx });
        this.importFuncMap[name] = funcIdx;
        return funcIdx;
    };

    // Return the absolute function index for an import by name.
    WasmCompiler.prototype._importIdx = function (name) {
        if (!this.importFuncMap.hasOwnProperty(name)) {
            throw new Error("Unknown import: " + name);
        }
        return this.importFuncMap[name];
    };

    // Intern a string constant into the data section; return {offset, length}.
    WasmCompiler.prototype._internString = function (s) {
        if (this.stringMap.hasOwnProperty(s)) {
            return this.stringMap[s];
        }
        this.needsMemory = true;
        var bytes = [];
        for (var i = 0; i < s.length; i++) {
            bytes.push(s.charCodeAt(i) & 0xFF);
        }
        var info = { offset: this.nextDataOffset, length: bytes.length };
        this.dataSegments.push({ offset: this.nextDataOffset, bytes: bytes });
        this.nextDataOffset += bytes.length;
        this.stringMap[s] = info;
        return info;
    };

    // -----------------------------------------------------------------------
    // Compile entry point
    // -----------------------------------------------------------------------

    WasmCompiler.prototype.compile = function (root) {
        if (root.nodeType !== Node.PROGRAM) {
            throw new PascalError(null, "WasmCompiler: expected PROGRAM node");
        }

        // Set up built-in imports.
        this._setupImports();

        // First pass: assign global indices and function indices.
        this._firstPass(root);

        // Second pass: compile each function/procedure body.
        this._compileProgram(root);

        // Generate the binary.
        return this._generateBinary();
    };

    // Set up JS import functions available to the WASM module.
    WasmCompiler.prototype._setupImports = function () {
        this._addImport("env", "write_i32",     [WASM_I32], []);
        this._addImport("env", "write_f64",     [WASM_F64], []);
        this._addImport("env", "write_str",     [WASM_I32, WASM_I32], []); // ptr, len
        this._addImport("env", "writeln_finish", [],        []);
        this._addImport("env", "write_bool",    [WASM_I32], []);
        // Math helpers (for Sin, Cos, Sqrt, etc.).
        this._addImport("env", "math_sin",   [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_cos",   [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_sqrt",  [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_abs",   [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_sqr",   [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_ln",    [WASM_F64], [WASM_F64]);
        this._addImport("env", "math_round", [WASM_F64], [WASM_I32]);
        this._addImport("env", "math_trunc", [WASM_F64], [WASM_I32]);
    };

    // -----------------------------------------------------------------------
    // First pass: collect globals and function indices
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._firstPass = function (root) {
        // Register all program-level variable declarations as WASM globals.
        this._collectGlobals(root.declarations);

        // Register all user-defined procedures/functions.
        this._collectFunctions(root.declarations);
    };

    WasmCompiler.prototype._collectGlobals = function (declarations) {
        if (!declarations) { return; }
        for (var i = 0; i < declarations.length; i++) {
            var decl = declarations[i];
            if (decl.nodeType === Node.VAR) {
                var wasmType = pascalTypeToWasm(decl.type);
                var gIdx = this.globals.length;
                var initVal = (wasmType === WASM_F64) ? 0.0 : 0;
                this.globals.push({ wasmType: wasmType, initVal: initVal });
                this.globalMap[decl.name.token.value.toLowerCase()] = gIdx;
            }
        }
    };

    WasmCompiler.prototype._collectFunctions = function (declarations) {
        if (!declarations) { return; }
        for (var i = 0; i < declarations.length; i++) {
            var decl = declarations[i];
            if (decl.nodeType === Node.PROCEDURE || decl.nodeType === Node.FUNCTION) {
                var name = decl.name.token.value.toLowerCase();
                var absIdx = this.imports.length + this.userFuncs.length;
                this.funcIndexMap[name] = absIdx;
                // Reserve slot; body compiled later.
                this.userFuncs.push({ typeIdx: -1, func: null, name: name, node: decl });

                // Recursively collect nested declarations.
                this._collectFunctions(decl.declarations);
            }
        }
    };

    // -----------------------------------------------------------------------
    // Second pass: compile each function/procedure body
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileProgram = function (root) {
        // Compile all declared sub-programs first.
        for (var i = 0; i < root.declarations.length; i++) {
            var decl = root.declarations[i];
            if (decl.nodeType === Node.PROCEDURE || decl.nodeType === Node.FUNCTION) {
                this._compileSub(decl);
            }
        }

        // Compile the main block as the last function.
        this.mainFuncUserIdx = this.userFuncs.length;
        var mainFunc = new WasmFunc([], [], this);
        this._compileBlock(root.block, mainFunc, null);
        mainFunc.emit(OP_END);
        var mainTypeIdx = this._typeIndex([], []);
        this.userFuncs.push({ typeIdx: mainTypeIdx, func: mainFunc, name: "__main__" });
    };

    // Compile a nested procedure or function declaration.
    WasmCompiler.prototype._compileSub = function (node) {
        var name = node.name.token.value.toLowerCase();

        // First compile any nested subs.
        if (node.declarations) {
            for (var i = 0; i < node.declarations.length; i++) {
                var decl = node.declarations[i];
                if (decl.nodeType === Node.PROCEDURE || decl.nodeType === Node.FUNCTION) {
                    this._compileSub(decl);
                }
            }
        }

        var isFunc = (node.nodeType === Node.FUNCTION);

        // Parameters live in node.expressionType.parameters (SUBPROGRAM_TYPE).
        var subType = node.expressionType;
        var params = [];
        var paramInfos = []; // {name, wasmType}

        if (subType && subType.parameters) {
            for (var i = 0; i < subType.parameters.length; i++) {
                var p = subType.parameters[i];
                var wt = pascalTypeToWasm(p.type);
                var pname = p.name.token.value.toLowerCase();
                params.push(wt);
                paramInfos.push({ name: pname, wasmType: wt });
            }
        }

        // Return type lives in node.expressionType.returnType.
        var results = [];
        var returnWasmType = WASM_VOID;
        if (isFunc && subType && subType.returnType && !subType.returnType.isVoidType()) {
            returnWasmType = pascalTypeToWasm(subType.returnType);
            results.push(returnWasmType);
        }

        var typeIdx = this._typeIndex(params, results);
        var func = new WasmFunc(params, results, this);

        // Register parameters as locals at indices 0..n-1.
        for (var i = 0; i < paramInfos.length; i++) {
            func.addParam(paramInfos[i].name, paramInfos[i].wasmType);
        }

        // Add a __result__ local for functions.
        var resultLocalIdx = -1;
        if (isFunc && results.length > 0) {
            resultLocalIdx = func.addLocal("__result__", returnWasmType);
        }

        // Collect local variable declarations and add them.
        if (node.declarations) {
            for (var i = 0; i < node.declarations.length; i++) {
                var decl = node.declarations[i];
                if (decl.nodeType === Node.VAR) {
                    var wt2 = pascalTypeToWasm(decl.type);
                    func.addLocal(decl.name.token.value.toLowerCase(), wt2);
                }
            }
        }

        // Compile the body.
        this._compileBlock(node.block, func, { name: name, resultLocalIdx: resultLocalIdx });

        // Push the return value for functions.
        if (isFunc && resultLocalIdx >= 0) {
            func.emit(OP_LOCAL_GET);
            func.emitUleb(resultLocalIdx);
        }
        func.emit(OP_END);

        // Update the slot reserved in the first pass.
        var slotIdx = this.funcIndexMap[name] - this.imports.length;
        this.userFuncs[slotIdx].typeIdx = typeIdx;
        this.userFuncs[slotIdx].func = func;
    };

    // -----------------------------------------------------------------------
    // Compile a block (BEGIN...END)
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileBlock = function (block, func, subCtx) {
        if (!block || block.nodeType !== Node.BLOCK) { return; }
        for (var i = 0; i < block.statements.length; i++) {
            this._compileStatement(block.statements[i], func, subCtx);
        }
    };

    // -----------------------------------------------------------------------
    // Compile a statement
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileStatement = function (node, func, subCtx) {
        switch (node.nodeType) {
            case Node.ASSIGNMENT:
                this._compileAssignment(node, func, subCtx);
                break;

            case Node.PROCEDURE_CALL:
                this._compileProcedureCall(node, func, subCtx);
                break;

            case Node.IF:
                this._compileIf(node, func, subCtx);
                break;

            case Node.WHILE:
                this._compileWhile(node, func, subCtx);
                break;

            case Node.FOR:
                this._compileFor(node, func, subCtx);
                break;

            case Node.REPEAT:
                this._compileRepeat(node, func, subCtx);
                break;

            case Node.BLOCK:
                this._compileBlock(node, func, subCtx);
                break;

            case Node.EXIT:
                if (subCtx && subCtx.resultLocalIdx >= 0) {
                    func.emit(OP_LOCAL_GET);
                    func.emitUleb(subCtx.resultLocalIdx);
                }
                func.emit(OP_RETURN);
                break;

            default:
                // Ignore unsupported statement nodes.
                break;
        }
    };

    // -----------------------------------------------------------------------
    // Compile an assignment
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileAssignment = function (node, func, subCtx) {
        var lhs = node.lhs;
        var rhs = node.rhs;

        // Check if this is assigning the return value (function name := expr).
        if (subCtx && lhs.nodeType === Node.IDENTIFIER &&
                lhs.token.value.toLowerCase() === subCtx.name &&
                subCtx.resultLocalIdx >= 0) {
            this._compileExpression(rhs, func, subCtx);
            func.emit(OP_LOCAL_SET);
            func.emitUleb(subCtx.resultLocalIdx);
            return;
        }

        // Compile rhs value first.
        this._compileExpression(rhs, func, subCtx);

        // Store to the lhs variable.
        this._emitStore(lhs, func);
    };

    // Emit a store to a variable (global or local).
    WasmCompiler.prototype._emitStore = function (lhs, func) {
        if (lhs.nodeType === Node.IDENTIFIER) {
            var name = lhs.token.value.toLowerCase();
            var localIdx = func.getLocalIdx(name);
            if (localIdx >= 0) {
                func.emit(OP_LOCAL_SET);
                func.emitUleb(localIdx);
                return;
            }
            var globalIdx = this.globalMap[name];
            if (globalIdx !== undefined) {
                func.emit(OP_GLOBAL_SET);
                func.emitUleb(globalIdx);
                return;
            }
        }
        // Unsupported lhs — drop the value.
        func.emit(OP_DROP);
    };

    // -----------------------------------------------------------------------
    // Compile a procedure call
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileProcedureCall = function (node, func, subCtx) {
        var symbolLookup = node.name.symbolLookup;
        var symbol = symbolLookup.symbol;
        var procName = symbol.name.toLowerCase();

        if (symbol.isNative) {
            this._compileNativeCall(procName, node.argumentList, func, subCtx);
        } else {
            this._compileUserCall(procName, node.argumentList, func, subCtx, false);
        }
    };

    // Compile a call to a built-in (native) procedure.
    WasmCompiler.prototype._compileNativeCall = function (name, args, func, subCtx) {
        switch (name) {
            case "writeln":
                this._compileWriteArgs(args, func, subCtx);
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("writeln_finish"));
                break;

            case "write":
                this._compileWriteArgs(args, func, subCtx);
                break;

            case "inc":
                // Inc(v) or Inc(v, n)
                if (args.length >= 1) {
                    var target = args[0];
                    var delta = (args.length >= 2) ? args[1] : null;
                    this._emitLoad(target, func);
                    if (delta) {
                        this._compileExpression(delta, func, subCtx);
                    } else {
                        func.emit(OP_I32_CONST);
                        func.emitSleb(1);
                    }
                    func.emit(OP_I32_ADD);
                    this._emitStore(target, func);
                }
                break;

            case "dec":
                // Dec(v) or Dec(v, n)
                if (args.length >= 1) {
                    var target = args[0];
                    var delta = (args.length >= 2) ? args[1] : null;
                    this._emitLoad(target, func);
                    if (delta) {
                        this._compileExpression(delta, func, subCtx);
                    } else {
                        func.emit(OP_I32_CONST);
                        func.emitSleb(1);
                    }
                    func.emit(OP_I32_SUB);
                    this._emitStore(target, func);
                }
                break;

            case "halt":
                func.emit(OP_UNREACHABLE);
                break;

            default:
                // Other native procedures: evaluate and drop arguments.
                for (var i = 0; i < args.length; i++) {
                    this._compileExpression(args[i], func, subCtx);
                    func.emit(OP_DROP);
                }
                break;
        }
    };

    // Emit write calls for each argument (without the trailing newline).
    WasmCompiler.prototype._compileWriteArgs = function (args, func, subCtx) {
        for (var i = 0; i < args.length; i++) {
            var arg = args[i];
            var argType = arg.expressionType;

            if (arg.nodeType === Node.STRING) {
                // String literal.
                var sinfo = this._internString(arg.token.value);
                func.emit(OP_I32_CONST);
                func.emitSleb(sinfo.offset);
                func.emit(OP_I32_CONST);
                func.emitSleb(sinfo.length);
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("write_str"));
            } else if (argType && argType.nodeType === Node.SIMPLE_TYPE &&
                       argType.typeCode === inst.R) {
                this._compileExpression(arg, func, subCtx);
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("write_f64"));
            } else if (argType && argType.nodeType === Node.SIMPLE_TYPE &&
                       argType.typeCode === inst.B) {
                this._compileExpression(arg, func, subCtx);
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("write_bool"));
            } else if (argType && argType.nodeType === Node.SIMPLE_TYPE &&
                       argType.typeCode === inst.S) {
                // String variable — not supported yet, skip.
            } else {
                // Integer or char: emit as i32.
                this._compileExpression(arg, func, subCtx);
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("write_i32"));
            }
        }
    };

    // Compile a call to a user-defined procedure/function.
    WasmCompiler.prototype._compileUserCall = function (name, args, func, subCtx, isExpr) {
        var lname = name.toLowerCase();
        for (var i = 0; i < args.length; i++) {
            this._compileExpression(args[i], func, subCtx);
        }
        var absIdx = this.funcIndexMap[lname];
        if (absIdx === undefined) {
            throw new PascalError(null, "WasmCompiler: unknown function " + name);
        }
        func.emit(OP_CALL);
        func.emitUleb(absIdx);
        if (!isExpr) {
            // If this is a procedure call (not used as expression), drop any result.
            // We'll drop only if there's a known return value.
        }
    };

    // -----------------------------------------------------------------------
    // Compile control flow
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileIf = function (node, func, subCtx) {
        this._compileExpression(node.expression, func, subCtx);
        func.emit(OP_IF);
        func.emit(WASM_VOID);
        this._compileStatement(node.thenStatement, func, subCtx);
        if (node.elseStatement) {
            func.emit(OP_ELSE);
            this._compileStatement(node.elseStatement, func, subCtx);
        }
        func.emit(OP_END);
    };

    WasmCompiler.prototype._compileWhile = function (node, func, subCtx) {
        // block $exit
        //   loop $continue
        //     <condition>
        //     i32.eqz
        //     br_if $exit (break out if condition is false)
        //     <body>
        //     br $continue
        //   end
        // end
        func.emit(OP_BLOCK); func.emit(WASM_VOID);
        func.emit(OP_LOOP);  func.emit(WASM_VOID);
        this._compileExpression(node.expression, func, subCtx);
        func.emit(OP_I32_EQZ);
        func.emit(OP_BR_IF);
        func.emitUleb(1); // break to outer block ($exit)
        this._compileStatement(node.statement, func, subCtx);
        func.emit(OP_BR);
        func.emitUleb(0); // continue loop ($continue)
        func.emit(OP_END); // end loop
        func.emit(OP_END); // end block
    };

    WasmCompiler.prototype._compileRepeat = function (node, func, subCtx) {
        // loop $continue
        //   <body>
        //   <condition>
        //   i32.eqz
        //   br_if $continue  (loop again if condition not yet true)
        // end
        func.emit(OP_LOOP); func.emit(WASM_VOID);
        this._compileBlock(node.block, func, subCtx);
        this._compileExpression(node.expression, func, subCtx);
        func.emit(OP_I32_EQZ);
        func.emit(OP_BR_IF);
        func.emitUleb(0); // go back to loop start
        func.emit(OP_END);
    };

    WasmCompiler.prototype._compileFor = function (node, func, subCtx) {
        // for i := fromExpr to toExpr do body
        // Allocate a temporary local for the limit value so toExpr is evaluated once.
        var varName = node.variable.token.value.toLowerCase();
        var limitLocalIdx = func.addLocal("__forlimit_" + (this._localCounter++), WASM_I32);

        // Initialize the loop variable.
        this._compileExpression(node.fromExpr, func, subCtx);
        this._emitStore(node.variable, func);

        // Compute and store the limit.
        this._compileExpression(node.toExpr, func, subCtx);
        func.emit(OP_LOCAL_SET);
        func.emitUleb(limitLocalIdx);

        // block $exit
        //   loop $continue
        //     if downto: i < limit  → br_if $exit
        //     if to:     i > limit  → br_if $exit
        //     <body>
        //     i := i +/- 1
        //     br $continue
        //   end
        // end
        func.emit(OP_BLOCK); func.emit(WASM_VOID);
        func.emit(OP_LOOP);  func.emit(WASM_VOID);

        this._emitLoad(node.variable, func);
        func.emit(OP_LOCAL_GET);
        func.emitUleb(limitLocalIdx);

        if (node.downto) {
            func.emit(OP_I32_LT_S); // i < limit → exit
        } else {
            func.emit(OP_I32_GT_S); // i > limit → exit
        }
        func.emit(OP_BR_IF);
        func.emitUleb(1); // exit block

        this._compileStatement(node.body, func, subCtx);

        // Increment/decrement loop variable.
        this._emitLoad(node.variable, func);
        func.emit(OP_I32_CONST);
        func.emitSleb(1);
        func.emit(node.downto ? OP_I32_SUB : OP_I32_ADD);
        this._emitStore(node.variable, func);

        func.emit(OP_BR);
        func.emitUleb(0); // continue loop
        func.emit(OP_END); // end loop
        func.emit(OP_END); // end block
    };

    // -----------------------------------------------------------------------
    // Compile an expression — pushes a value onto the WASM stack.
    // Returns the WASM type of the produced value.
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._compileExpression = function (node, func, subCtx) {
        switch (node.nodeType) {
            case Node.NUMBER: {
                var v = node.getNumber();
                if ((v | 0) === v && node.expressionType &&
                        node.expressionType.typeCode === inst.I) {
                    func.emit(OP_I32_CONST);
                    func.emitSleb(v | 0);
                    return WASM_I32;
                } else {
                    func.emit(OP_F64_CONST);
                    func.emitBytes(encF64(v));
                    return WASM_F64;
                }
            }

            case Node.BOOLEAN: {
                func.emit(OP_I32_CONST);
                func.emitSleb(node.getBoolean() ? 1 : 0);
                return WASM_I32;
            }

            case Node.STRING: {
                // A bare string expression: intern it and push offset+length.
                // Callers that expect a single value will get the offset.
                var sinfo = this._internString(node.token.value);
                func.emit(OP_I32_CONST);
                func.emitSleb(sinfo.offset);
                return WASM_I32;
            }

            case Node.IDENTIFIER: {
                this._emitLoad(node, func);
                return pascalTypeToWasm(node.expressionType);
            }

            case Node.CAST: {
                var innerType = this._compileExpression(node.expression, func, subCtx);
                var targetType = pascalTypeToWasm(node.type);
                if (innerType === WASM_I32 && targetType === WASM_F64) {
                    func.emit(OP_F64_CONVERT_I32_S);
                } else if (innerType === WASM_F64 && targetType === WASM_I32) {
                    func.emit(OP_I32_TRUNC_F64_S);
                }
                return targetType;
            }

            case Node.NEGATIVE: {
                var t = this._compileExpression(node.expression, func, subCtx);
                if (t === WASM_F64) {
                    func.emit(OP_F64_NEG);
                } else {
                    // Negate i32: x * -1
                    func.emit(OP_I32_CONST); func.emitSleb(-1);
                    func.emit(OP_I32_MUL);
                }
                return t;
            }

            case Node.NOT: {
                this._compileExpression(node.expression, func, subCtx);
                // Boolean NOT: eqz (0→1, non-zero→0)
                func.emit(OP_I32_EQZ);
                return WASM_I32;
            }

            case Node.FUNCTION_CALL: {
                var sym = node.name.symbolLookup.symbol;
                var fname = sym.name.toLowerCase();
                if (sym.isNative) {
                    return this._compileNativeFunctionCall(fname, node.argumentList, func, subCtx, node.expressionType);
                } else {
                    this._compileUserCall(fname, node.argumentList, func, subCtx, true);
                    return pascalTypeToWasm(node.expressionType);
                }
            }

            // Binary operators
            case Node.ADDITION:
            case Node.SUBTRACTION:
            case Node.MULTIPLICATION:
            case Node.DIVISION:
            case Node.INTEGER_DIVISION:
            case Node.MOD:
            case Node.AND:
            case Node.OR:
            case Node.EQUALITY:
            case Node.INEQUALITY:
            case Node.LESS_THAN:
            case Node.GREATER_THAN:
            case Node.LESS_THAN_OR_EQUAL_TO:
            case Node.GREATER_THAN_OR_EQUAL_TO:
                return this._compileBinaryOp(node, func, subCtx);

            default:
                // Unsupported expression; push a zero placeholder.
                func.emit(OP_I32_CONST); func.emitSleb(0);
                return WASM_I32;
        }
    };

    // Compile a binary operation.
    WasmCompiler.prototype._compileBinaryOp = function (node, func, subCtx) {
        var ltype = this._compileExpression(node.lhs, func, subCtx);
        var rtype = this._compileExpression(node.rhs, func, subCtx);
        var isReal = (ltype === WASM_F64 || rtype === WASM_F64);

        switch (node.nodeType) {
            case Node.ADDITION:
                func.emit(isReal ? OP_F64_ADD : OP_I32_ADD);
                return isReal ? WASM_F64 : WASM_I32;
            case Node.SUBTRACTION:
                func.emit(isReal ? OP_F64_SUB : OP_I32_SUB);
                return isReal ? WASM_F64 : WASM_I32;
            case Node.MULTIPLICATION:
                func.emit(isReal ? OP_F64_MUL : OP_I32_MUL);
                return isReal ? WASM_F64 : WASM_I32;
            case Node.DIVISION:
                // Pascal's '/' operator always produces a real result.
                // The Parser inserts CAST nodes so both operands are already f64.
                func.emit(OP_F64_DIV);
                return WASM_F64;
            case Node.INTEGER_DIVISION:
                func.emit(OP_I32_DIV_S);
                return WASM_I32;
            case Node.MOD:
                func.emit(OP_I32_REM_S);
                return WASM_I32;
            case Node.AND:
                func.emit(OP_I32_AND);
                return WASM_I32;
            case Node.OR:
                func.emit(OP_I32_OR);
                return WASM_I32;
            case Node.EQUALITY:
                func.emit(isReal ? OP_F64_EQ : OP_I32_EQ);
                return WASM_I32;
            case Node.INEQUALITY:
                func.emit(isReal ? OP_F64_NE : OP_I32_NE);
                return WASM_I32;
            case Node.LESS_THAN:
                func.emit(isReal ? OP_F64_LT : OP_I32_LT_S);
                return WASM_I32;
            case Node.GREATER_THAN:
                func.emit(isReal ? OP_F64_GT : OP_I32_GT_S);
                return WASM_I32;
            case Node.LESS_THAN_OR_EQUAL_TO:
                func.emit(isReal ? OP_F64_LE : OP_I32_LE_S);
                return WASM_I32;
            case Node.GREATER_THAN_OR_EQUAL_TO:
                func.emit(isReal ? OP_F64_GE : OP_I32_GE_S);
                return WASM_I32;
            default:
                func.emit(OP_I32_CONST); func.emitSleb(0);
                return WASM_I32;
        }
    };

    // Compile a native function call (one that returns a value).
    WasmCompiler.prototype._compileNativeFunctionCall = function (name, args, func, subCtx, exprType) {
        switch (name) {
            case "sin":
            case "cos":
            case "sqrt":
            case "abs":
            case "sqr":
            case "ln": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                // Use imported JS math functions.
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("math_" + name));
                return WASM_F64;
            }

            case "round":
            case "trunc": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                func.emit(OP_CALL);
                func.emitUleb(this._importIdx("math_" + name));
                return WASM_I32;
            }

            case "odd": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                func.emit(OP_I32_CONST); func.emitSleb(1);
                func.emit(OP_I32_AND);
                return WASM_I32;
            }

            case "succ": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                func.emit(OP_I32_CONST); func.emitSleb(1);
                func.emit(OP_I32_ADD);
                return WASM_I32;
            }

            case "pred": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                func.emit(OP_I32_CONST); func.emitSleb(1);
                func.emit(OP_I32_SUB);
                return WASM_I32;
            }

            case "ord":
            case "chr": {
                if (args.length >= 1) {
                    this._compileExpression(args[0], func, subCtx);
                }
                return WASM_I32;
            }

            default:
                func.emit(OP_I32_CONST); func.emitSleb(0);
                return WASM_I32;
        }
    };

    // -----------------------------------------------------------------------
    // Load a variable value onto the WASM stack
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._emitLoad = function (node, func) {
        if (node.nodeType === Node.IDENTIFIER) {
            var name = node.token.value.toLowerCase();
            var localIdx = func.getLocalIdx(name);
            if (localIdx >= 0) {
                func.emit(OP_LOCAL_GET);
                func.emitUleb(localIdx);
                return;
            }
            var globalIdx = this.globalMap[name];
            if (globalIdx !== undefined) {
                func.emit(OP_GLOBAL_GET);
                func.emitUleb(globalIdx);
                return;
            }
            // Check if it's a constant (symbol with a value).
            if (node.symbolLookup && node.symbolLookup.symbol.value !== null) {
                var val = node.symbolLookup.symbol.value;
                var wasmType = pascalTypeToWasm(node.expressionType);
                if (wasmType === WASM_F64) {
                    func.emit(OP_F64_CONST);
                    func.emitBytes(encF64(+val));
                } else {
                    func.emit(OP_I32_CONST);
                    func.emitSleb(+val | 0);
                }
                return;
            }
        }
        // Fallback: push 0.
        func.emit(OP_I32_CONST); func.emitSleb(0);
    };

    // -----------------------------------------------------------------------
    // Generate the binary WASM module
    // -----------------------------------------------------------------------

    WasmCompiler.prototype._generateBinary = function () {
        var bytes = [];

        // Magic + version.
        bytes = bytes.concat([0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00]);

        // Type section.
        var typeContent = uleb128(this.types.length);
        for (var i = 0; i < this.types.length; i++) {
            var t = this.types[i];
            typeContent = typeContent.concat([0x60]); // func type
            typeContent = typeContent.concat(uleb128(t.params.length));
            typeContent = typeContent.concat(t.params);
            typeContent = typeContent.concat(uleb128(t.results.length));
            typeContent = typeContent.concat(t.results);
        }
        bytes = bytes.concat(section(SEC_TYPE, typeContent));

        // Import section.
        if (this.imports.length > 0) {
            var importContent = uleb128(this.imports.length);
            for (var i = 0; i < this.imports.length; i++) {
                var imp = this.imports[i];
                importContent = importContent
                    .concat(encStr(imp.module))
                    .concat(encStr(imp.name))
                    .concat([0x00]) // function import kind
                    .concat(uleb128(imp.typeIdx));
            }
            bytes = bytes.concat(section(SEC_IMPORT, importContent));
        }

        // Function section (user-defined functions).
        if (this.userFuncs.length > 0) {
            var funcContent = uleb128(this.userFuncs.length);
            for (var i = 0; i < this.userFuncs.length; i++) {
                funcContent = funcContent.concat(uleb128(this.userFuncs[i].typeIdx));
            }
            bytes = bytes.concat(section(SEC_FUNCTION, funcContent));
        }

        // Memory section (if needed).
        if (this.needsMemory) {
            // One memory with min=1 page (64 KiB), no max.
            bytes = bytes.concat(section(SEC_MEMORY, [0x01, 0x00, 0x01]));
        }

        // Global section.
        if (this.globals.length > 0) {
            var globalContent = uleb128(this.globals.length);
            for (var i = 0; i < this.globals.length; i++) {
                var g = this.globals[i];
                globalContent = globalContent.concat([g.wasmType, 0x01]); // mutable
                if (g.wasmType === WASM_F64) {
                    globalContent = globalContent.concat([OP_F64_CONST]).concat(encF64(g.initVal));
                } else {
                    globalContent = globalContent.concat([OP_I32_CONST]).concat(sleb128(0));
                }
                globalContent = globalContent.concat([OP_END]);
            }
            bytes = bytes.concat(section(SEC_GLOBAL, globalContent));
        }

        // Export section: export __main__ and memory.
        var mainAbsIdx = this.imports.length + this.mainFuncUserIdx;
        var exportContent = [];
        var exportCount = 1;
        if (this.needsMemory) { exportCount++; }
        exportContent = uleb128(exportCount);
        exportContent = exportContent
            .concat(encStr("__main__"))
            .concat([0x00]) // function export
            .concat(uleb128(mainAbsIdx));
        if (this.needsMemory) {
            exportContent = exportContent
                .concat(encStr("memory"))
                .concat([0x02]) // memory export
                .concat(uleb128(0));
        }
        bytes = bytes.concat(section(SEC_EXPORT, exportContent));

        // Code section (function bodies).
        if (this.userFuncs.length > 0) {
            var codeContent = uleb128(this.userFuncs.length);
            for (var i = 0; i < this.userFuncs.length; i++) {
                var f = this.userFuncs[i].func;
                var body = f.encodeBody();
                codeContent = codeContent.concat(uleb128(body.length)).concat(body);
            }
            bytes = bytes.concat(section(SEC_CODE, codeContent));
        }

        // Data section (string constants).
        if (this.dataSegments.length > 0) {
            var dataContent = uleb128(this.dataSegments.length);
            for (var i = 0; i < this.dataSegments.length; i++) {
                var seg = this.dataSegments[i];
                dataContent = dataContent
                    .concat([0x00]) // memory index 0
                    .concat([OP_I32_CONST]).concat(sleb128(seg.offset)).concat([OP_END])
                    .concat(uleb128(seg.bytes.length))
                    .concat(seg.bytes);
            }
            bytes = bytes.concat(section(SEC_DATA, dataContent));
        }

        return new Uint8Array(bytes);
    };

    // -----------------------------------------------------------------------
    // WasmFunc: accumulates the code for a single WASM function
    // -----------------------------------------------------------------------

    var WasmFunc = function (params, results, compiler) {
        this.params = params;
        this.results = results;
        this.compiler = compiler;

        // Locals added beyond params: list of WASM types.
        this.extraLocals = [];

        // Next local index. Params occupy indices 0..params.length-1 and are
        // registered via addParam(). Additional locals are registered via addLocal().
        this.nextLocalIdx = 0;

        // Map from normalized name → local index.
        this.localMap = {};

        // The instruction bytes.
        this.code = [];
    };

    WasmFunc.prototype.addParam = function (name, wasmType) {
        var idx = this.nextLocalIdx++;
        this.localMap[name.toLowerCase()] = idx;
        return idx;
    };

    WasmFunc.prototype.addLocal = function (name, wasmType) {
        var idx = this.nextLocalIdx++;
        this.extraLocals.push(wasmType);
        this.localMap[name.toLowerCase()] = idx;
        return idx;
    };

    WasmFunc.prototype.getLocalIdx = function (name) {
        var idx = this.localMap[name.toLowerCase()];
        return (idx !== undefined) ? idx : -1;
    };

    WasmFunc.prototype.emit = function (byte_) {
        this.code.push(byte_ & 0xFF);
    };

    WasmFunc.prototype.emitBytes = function (bytes) {
        for (var i = 0; i < bytes.length; i++) {
            this.code.push(bytes[i] & 0xFF);
        }
    };

    WasmFunc.prototype.emitUleb = function (v) {
        this.emitBytes(uleb128(v));
    };

    WasmFunc.prototype.emitSleb = function (v) {
        this.emitBytes(sleb128(v));
    };

    // Encode the function body for the code section.
    WasmFunc.prototype.encodeBody = function () {
        // Group extra locals by consecutive type for compact encoding.
        var localDecls = [];
        var i = 0;
        while (i < this.extraLocals.length) {
            var t = this.extraLocals[i];
            var count = 1;
            while (i + count < this.extraLocals.length && this.extraLocals[i + count] === t) {
                count++;
            }
            localDecls.push({ count: count, type: t });
            i += count;
        }

        var body = uleb128(localDecls.length);
        for (var j = 0; j < localDecls.length; j++) {
            body = body.concat(uleb128(localDecls[j].count)).concat([localDecls[j].type]);
        }
        body = body.concat(this.code);
        return body;
    };

    return WasmCompiler;
});
