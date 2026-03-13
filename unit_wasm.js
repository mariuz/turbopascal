// Unit tests for the WasmCompiler backend. Run by loading unit_wasm.html.

'use strict';

require.config({
    paths: {
        "jquery": "vendor/jquery-1.10.1.min",
        "underscore": "vendor/underscore-1.5.2.min"
    }
});

require(["jquery", "Stream", "Token", "Lexer", "CommentStripper", "Parser",
        "PascalError", "WasmCompiler", "WasmMachine", "SymbolTable"],
        function ($, Stream, Token, Lexer, CommentStripper,
                  Parser, PascalError, WasmCompiler, WasmMachine, SymbolTable) {

    var $results = $("#results tbody");

    var generateResult = function (name, passed, reason) {
        $results.append($("<tr>").
                        append($("<td>").text(name)).
                        append($("<td>").append(
                            $("<span>").text(passed ? "passed" : "failed").
                                addClass(passed ? "passed" : "failure"))).
                        append($("<td>").text(reason)));
    };

    // Run each test script sequentially (WebAssembly.instantiate is async).
    var tests = $('script[type="text/pascal"]').toArray();
    var runNext = function (idx) {
        if (idx >= tests.length) { return; }
        var el = tests[idx];
        var $test = $(el);
        var name = $test.attr("id");
        var source = $test.text();
        var stream = new Stream(source);
        var lexer = new CommentStripper(new Lexer(stream));
        var parser = new Parser(lexer);
        var output = "";

        try {
            var builtinSymbolTable = SymbolTable.makeBuiltinSymbolTable();
            var root = parser.parse(builtinSymbolTable);

            var compiler = new WasmCompiler();
            var wasmBytes = compiler.compile(root);

            var machine = new WasmMachine(wasmBytes);
            machine.setOutputCallback(function (line) {
                if (output.length > 0) { output += " "; }
                output += line.trim();
            });
            machine.setFinishCallback(function () {
                var expected = $.trim($test.data("expected"));
                output = $.trim(output);
                if (output === expected) {
                    generateResult(name, true, "");
                } else {
                    generateResult(name, false, "expected \"" +
                                   expected + "\" but got \"" + output + "\"");
                }
                runNext(idx + 1);
            });
            machine.run().catch(function (e) {
                generateResult(name, false, "WASM runtime error: " + e.message);
                runNext(idx + 1);
            });
        } catch (e) {
            var message;
            if (e instanceof PascalError) {
                message = e.getMessage();
            } else {
                message = e.message || "Unknown error";
            }
            console.error(name + ":", e);
            generateResult(name, false, message);
            runNext(idx + 1);
        }
    };

    runNext(0);
});
