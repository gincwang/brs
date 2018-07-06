import Long from "long";

import {
    BrsType,
    BrsString,
    ValueKind,
    BrsInvalid,
    isBrsNumber,
    isBrsString,
    BrsBoolean,
    isBrsBoolean,
    Int32,
    Int64,
    Float,
    Double,
    isBrsCallable,
    BrsValue
} from "../brsTypes";

import * as Expr from "../parser/Expression";
import * as Stmt from "../parser/Statement";
import { Lexeme } from "../Lexeme";
import { stringify } from "../Stringify";
import * as BrsError from "../Error";

import * as StdLib from "../stdlib";

import Environment from "./Environment";
import { OutputProxy } from "./OutputProxy";
import { toCallable } from "./BrsFunction";
import { BlockEnd, StopReason } from "../parser/Statement";

export interface OutputStreams {
    stdout: NodeJS.WriteStream,
    stderr: NodeJS.WriteStream
}

export class Interpreter implements Expr.Visitor<BrsType>, Stmt.Visitor<BrsType> {
    private readonly globals = new Environment();
    private _environment = this.globals;
    readonly stdout: OutputProxy;
    readonly stderr: OutputProxy;

    get environment() {
        return this._environment;
    }

    /**
     * Creates a new Interpreter, including any global properties and functions.
     * @param outputStreams the WriteStreams to use for `stdout` and `stderr`.
     */
    constructor(outputStreams: OutputStreams = process) {
        this.stdout = new OutputProxy(outputStreams.stdout);
        this.stderr = new OutputProxy(outputStreams.stderr);

        this.globals.define("RebootSystem", StdLib.RebootSystem);
        this.globals.define("UCase", StdLib.UCase);
        this.globals.define("LCase", StdLib.LCase);
        this.globals.define("Asc", StdLib.Asc);
        this.globals.define("Chr", StdLib.Chr);
        this.globals.define("Pos", StdLib.Pos);
        this.globals.define("Left", StdLib.Left);
    }

    /**
     * Temporarily sets an interpreter's environment to the provided one, then
     * passes the sub-interpreter to the provided JavaScript function. Always
     * reverts the current interpreter's environment to its original value.
     * @param environment the sub-environment to use for the interpreter
     *                    provided to `func`.
     * @param func the JavaScript function to execute with the sub interpreter.
     */
    inSubEnv(environment: Environment, func: (interpreter: Interpreter) => void) {
        let originalEnvironment = this._environment;
        try {
            this._environment = environment;
            return func(this);
        } finally {
            this._environment = originalEnvironment
        }
    }

    exec(statements: ReadonlyArray<Stmt.Statement>) {
        return statements.map((statement) => this.execute(statement));
    }

    /**
     * Executes a block in the context of the provided environment.
     * The original environment will be restored after execution finishes --
     * even if an error occurs.
     *
     * @param statements an array of statements to execute
     * @param environment the environment in which those statements will be executed
     * @returns an array of `Result`s, one for each executed statement
     */
    executeBlock(block: Stmt.Block, environment: Environment) {
        let originalEnvironment = this.environment;
        try {
            this._environment = environment;
            return block.accept(this);
        } finally {
            this._environment = originalEnvironment;
        }
    }

    visitAssign(statement: Expr.Assign): BrsType {
        return BrsInvalid.Instance;
    }

    visitNamedFunction(statement: Stmt.Function): BrsType {
        if (this.environment.has(statement.name)) {
            // TODO: Figure out how to determine where the original version was declared
            // Maybe `Environment.define` records the location along with the value?
            BrsError.make(
                `Attempting to declare function '${statement.name.text}', but ` +
                `a property of that name already exists.`,
                statement.name.line
            );
            return BrsInvalid.Instance;
        }

        this.environment.define(statement.name.text!, toCallable(statement));
        return BrsInvalid.Instance;
    }

    visitReturn(statement: Stmt.Return): never {
        if (!statement.value) {
            throw new Stmt.ReturnValue(statement.keyword, BrsInvalid.Instance);
        }

        let toReturn = this.evaluate(statement.value);
        throw new Stmt.ReturnValue(statement.keyword, toReturn);
    }

    visitExpression(statement: Stmt.Expression): BrsType {
        return this.evaluate(statement.expression);
    }

    visitPrint(statement: Stmt.Print): BrsType {
        // the `tab` function is only in-scope while executing print statements
        this.environment.define("Tab", StdLib.Tab);

        statement.expressions.forEach( (printable, index) => {
            switch (printable) {
                case Stmt.PrintSeparator.Tab:
                    this.stdout.write(
                        " ".repeat(16 - (this.stdout.position() % 16))
                    );
                    break;
                case Stmt.PrintSeparator.Space:
                    if (index === statement.expressions.length - 1) {
                        // Don't write an extra space for trailing `;` in print lists.
                        // They're used to suppress trailing newlines in `print` statements
                        break;
                    }

                    this.stdout.write(" ");
                    break;
                default:
                    this.stdout.write(
                        stringify(this.evaluate(printable))
                    );
                    break;
            }
        });

        if (statement.expressions[statement.expressions.length - 1] !== Stmt.PrintSeparator.Space) {
            this.stdout.write("\n");
        }

        // `tab` is only in-scope when executing print statements, so remove it before we leave
        this.environment.remove("Tab");

        return BrsInvalid.Instance;
    }

    visitAssignment(statement: Stmt.Assignment): BrsType {
        let value = this.evaluate(statement.value);
        this.environment.define(statement.name.text!, value);
        return BrsInvalid.Instance;
    }

    visitBinary(expression: Expr.Binary) {
        let lexeme = expression.token.kind;
        let left = this.evaluate(expression.left);
        let right: BrsType = BrsInvalid.Instance;

        if (lexeme !== Lexeme.And && lexeme !== Lexeme.Or) {
            // don't evaluate right-hand-side of boolean expressions, to preserve short-circuiting
            // behavior found in other languages. e.g. `foo() && bar()` won't execute `bar()` if
            // `foo()` returns `false`.
            right = this.evaluate(expression.right);
        }

        switch (lexeme) {
            case Lexeme.Minus:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.subtract(right);
                } else {
                    BrsError.make(
                        `Attempting to subtract non-numeric objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Star:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.multiply(right);
                } else {
                    BrsError.make(
                        `Attempting to multiply non-numeric objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Caret:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.pow(right);
                } else {
                    BrsError.make(
                        `Attempting to exponentiate non-numeric objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Slash:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.divide(right);
                }
                BrsError.make(
                    `Attempting to divide non-numeric objects.
                    left: ${typeof left}
                    right: ${typeof right}`,
                    expression.token.line
                );
                return BrsInvalid.Instance;
            case Lexeme.Mod:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.modulo(right);
                } else {
                    BrsError.make(
                        `Attempting to modulo non-numeric objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Backslash:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.intDivide(right);
                } else {
                    BrsError.make(
                        `Attempting to integer-divide non-numeric objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Plus:
                if (isBrsNumber(left) && isBrsNumber(right)) {
                    return left.add(right);
                } else if (isBrsString(left) && isBrsString(right)) {
                    return left.concat(right);
                } else {
                    BrsError.make(
                        `Attempting to add non-homogeneous objects.
                        left: ${typeof left}
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Greater:
                return left.greaterThan(right);
            case Lexeme.GreaterEqual:
                return left.greaterThan(right).or(left.equalTo(right));
            case Lexeme.Less:
                return left.lessThan(right);
            case Lexeme.LessEqual:
                return left.lessThan(right).or(left.equalTo(right));
            case Lexeme.Equal:
                return left.equalTo(right);
            case Lexeme.LessGreater:
                return left.equalTo(right).not();
            case Lexeme.And:
                if (isBrsBoolean(left) && !left.toBoolean()) {
                    // short-circuit ANDs - don't evaluate RHS if LHS is false
                    return BrsBoolean.False;
                } else if (isBrsBoolean(left)) {
                    right = this.evaluate(expression.right);
                    if (isBrsBoolean(right)) {
                        return (left as BrsBoolean).and(right);
                    }

                    BrsError.make(
                        `Attempting to 'and' boolean with non-boolean expression
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                } else if (isBrsNumber(left)) {
                    right = this.evaluate(expression.right);

                    if (isBrsNumber(right)) {
                        // TODO: support boolean AND with numbers
                        return left.and(right);
                    }

                    // TODO: figure out how to handle 32-bit int AND 64-bit int
                    BrsError.make(
                        `Attempting to bitwise 'and' number with non-numeric expression
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                } else {
                    BrsError.make(
                        `Attempting to 'and' unexpected expressions
                        left: ${typeof left},
                        right: ${typeof this.evaluate(expression.right)}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Or:
                if (isBrsBoolean(left) && left.toBoolean()) {
                    // short-circuit ORs - don't evaluate RHS if LHS is true
                    return BrsBoolean.True;
                } else if (isBrsBoolean(left)) {
                    right = this.evaluate(expression.right);
                    if (isBrsBoolean(right)) {
                        return (left as BrsBoolean).or(right);
                    } else {
                        BrsError.make(
                            `Attempting to 'or' boolean with non-boolean expression
                            right: ${typeof right}`,
                            expression.token.line
                        );
                        return BrsInvalid.Instance;
                    }
                } else if (isBrsNumber(left)) {
                    right = this.evaluate(expression.right);
                    if (isBrsNumber(right)) {
                        return left.or(right);
                    }

                    // TODO: figure out how to handle 32-bit int OR 64-bit int
                    BrsError.make(
                        `Attempting to bitwise 'or' number with non-numeric expression
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                } else {
                    BrsError.make(
                        `Attempting to 'or' unexpected objects
                        left: ${typeof left},
                        right: ${typeof right}`,
                        expression.token.line
                    );
                    return BrsInvalid.Instance;
                }
            default:
                BrsError.make(
                    `Received unexpected token kind '${expression.token.kind}'`,
                    expression.token.line
                );
                return BrsInvalid.Instance;
        }
    }

    visitBlock(block: Stmt.Block): BrsType {
        block.statements.forEach((statement) => this.execute(statement));
        return BrsInvalid.Instance;
    }

    visitExitFor(statement: Stmt.ExitFor): never {
        throw new Stmt.ExitForReason();
    }

    visitExitWhile(expression: Stmt.ExitWhile): never {
        throw new Stmt.ExitWhileReason();
    }

    visitCall(expression: Expr.Call) {
        let functionName = "[anonymous function]";
        if (expression.callee instanceof Expr.Variable) {
            if (expression.callee.name.text) {
                functionName = expression.callee.name.text;
            }
        }

        // evaluate the function to call (it could be the result of another function call)
        const callee = this.evaluate(expression.callee);
        // evaluate all of the arguments as well (they could also be function calls)
        const args = expression.args.map(this.evaluate, this);

        if (!isBrsCallable(callee)) {
            throw BrsError.make(
                `'${functionName}' is not a function and cannot be called.`,
                expression.closingParen.line
            )
        }

        if (callee.signature.name) {
            functionName = callee.signature.name;
        }

        // ensure argument counts match
        const arity = callee.arity;
        if (expression.args.length < arity.required) {
            throw BrsError.make(
                `'${functionName}' requires at least ${arity.required} arguments, ` +
                    `but received ${expression.args.length}.`,
                expression.closingParen.line
            )
        } else if (expression.args.length > arity.required + arity.optional) {
            throw BrsError.make(
                `'${functionName}' accepts at most ${arity.required + arity.optional} arguments, ` +
                    `but received ${expression.args.length}.`,
                expression.closingParen.line
            )
        }

        // ensure argument types match
        let typeMismatchFound = false;
        for (const index in args) {
            const signatureArg = callee.signature.args[index];
            if (signatureArg.type !== ValueKind.Dynamic && signatureArg.type !== args[index].kind) {
                typeMismatchFound = true;
                BrsError.make(
                    `Type mismatch in '${functionName}': argument '${signatureArg.name}' must be ` +
                        `of type ${ValueKind.toString(signatureArg.type)}, but received ` +
                        `${ValueKind.toString(args[index].kind)}.`,
                    expression.closingParen.line
                );
            }
        }

        if (typeMismatchFound) {
            throw new Error(
                `[Line ${expression.closingParen.line}] Type mismatch(es) detected.`
            );
        }

        try {
            return callee.call(this, ...args);
        } catch (reason) {
            if (reason.kind == null) {
                throw new Error("Something terrible happened and we didn't throw a `BlockEnd` instance.");
            }

            let returnedValue = (reason as Stmt.ReturnValue).value;
            let returnLocation = (reason as Stmt.ReturnValue).location;
            if (callee.signature.returns !== ValueKind.Dynamic && callee.signature.returns !== returnedValue.kind) {
                throw BrsError.make(
                    `Attempting to return value of type ${ValueKind.toString(returnedValue.kind)}, `
                    + `but function ${callee.signature.name} declares return value of type `
                    + ValueKind.toString(callee.signature.returns),
                    returnLocation.line
                );
            }

            return returnedValue;
        }
    }

    visitGet(expression: Expr.Get) {
        return BrsInvalid.Instance;
    }

    visitGrouping(expr: Expr.Grouping) {
        return this.evaluate(expr.expression);
    }

    visitFor(statement: Stmt.For): BrsType {
        // BrightScript for/to loops evaluate the counter initial value, final value, and increment
        // values *only once*, at the top of the for/to loop.
        this.execute(statement.counterDeclaration);
        const finalValue = this.evaluate(statement.finalValue);
        const increment = this.evaluate(statement.increment);

        const counterName = statement.counterDeclaration.name;
        const step = new Stmt.Assignment(
            counterName,
            new Expr.Binary(
                new Expr.Variable(counterName),
                { kind: Lexeme.Plus, text: "+", line: counterName.line },
                new Expr.Literal(increment)
            )
        );

        let loopExitReason: Stmt.BlockEnd | undefined;

        while (
            this.evaluate(new Expr.Variable(counterName))
                .equalTo(finalValue)
                .not()
                .toBoolean()
        ) {
            // execute the block
            try {
                this.execute(statement.body);
            } catch (reason) {
                if (reason.kind === Stmt.StopReason.ExitFor) {
                    loopExitReason = reason as BlockEnd;
                    break;
                } else {
                    // re-throw returns, runtime errors, etc.
                    throw reason;
                }
            }

            // then increment the counter
            this.execute(step);
        }

        // BrightScript for/to loops execute the body one more time when initial === final
        if (loopExitReason === undefined) {
            this.execute(statement.body);
            // they also increments the counter once more
            this.execute(step);
        }

        return BrsInvalid.Instance;
    }

    visitWhile(statement: Stmt.While): BrsType {
        while (this.evaluate(statement.condition).equalTo(BrsBoolean.True).toBoolean()) {
            try {
                this.execute(statement.body);
            } catch (reason) {
                if (reason.kind && reason.kind === Stmt.StopReason.ExitWhile) {
                    break;
                } else {
                    // re-throw returns, runtime errors, etc.
                    throw reason;
                }
            }
        }

        return BrsInvalid.Instance;
    }

    visitIf(statement: Stmt.If): BrsType {
        if (this.evaluate(statement.condition).equalTo(BrsBoolean.True).toBoolean()) {
            this.execute(statement.thenBranch);
            return BrsInvalid.Instance;
        } else {
            for (const elseIf of statement.elseIfs || []) {
                if (this.evaluate(elseIf.condition).equalTo(BrsBoolean.True).toBoolean()) {
                    this.execute(elseIf.thenBranch);
                    return BrsInvalid.Instance;
                }
            }

            if (statement.elseBranch) {
                this.execute(statement.elseBranch);
            }

            return BrsInvalid.Instance;
        }
    }

    visitLiteral(expression: Expr.Literal): BrsType {
        return expression.value;
    }

    visitLogical(expression: Expr.Logical) {
        return BrsInvalid.Instance;
    }
    visitM(expression: Expr.M) {
        return BrsInvalid.Instance;
    }
    visitSet(expression: Expr.Set) {
        return BrsInvalid.Instance;
    }

    visitUnary(expression: Expr.Unary) {
        let right = this.evaluate(expression.right);

        switch (expression.operator.kind) {
            case Lexeme.Minus:
                if (isBrsNumber(right)) {
                    return right.multiply(new Int32(-1));
                } else {
                    BrsError.make(
                        `Attempting to negate non-numeric value.
                        value type: ${typeof right}`,
                        expression.operator.line
                    );
                    return BrsInvalid.Instance;
                }
            case Lexeme.Not:
                if (isBrsBoolean(right)) {
                    return right.not();
                } else {
                    BrsError.make(
                        `Attempting to NOT non-boolean value.
                        value type: ${typeof right}`,
                        expression.operator.line
                    );
                    return BrsInvalid.Instance;
                }
        }

        return BrsInvalid.Instance;
    }

    visitVariable(expression: Expr.Variable) {
        return this.environment.get(expression.name);
    }

    evaluate(this: Interpreter, expression: Expr.Expression): BrsType {
        return expression.accept<BrsType>(this);
    }

    execute(this: Interpreter, statement: Stmt.Statement): BrsType {
        return statement.accept<BrsType>(this);
    }
}
