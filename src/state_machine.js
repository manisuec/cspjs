// # State machine support for task.js
//
// This file contains miscellaneous state machine management code
// that is used by the code generated by the `task` macro in task.js.

var Channel = require('./channel');

var nextTick = (function () {
    return this.setImmediate || process.nextTick;
}());

function State() {
    this.id = 0;
    this.args = [null, null];
    this.err = null;
    this.unwinding = [];
    this.waiting = 0;
    this.isFinished = false;
    this.isUnwinding = false;
    this.currentErrorStep = null;
    this.abort_with_error = null;
    return this;
}

function controlAPIMaker() {
    var state_machine = this;
    return Object.create({}, {
        abort: {
            value: function (err) {
                if (state_machine.state.waiting > 0) {
                    state_machine.state.abort_with_error = err;
                } else {
                    state_machine.callback(err);
                }
            }
        },
        isWaiting: {
            get: function () {
                return state_machine.state.waiting > 0;
            }
        },
        isFinished: {
            get: function () {
                return state_machine.state.isFinished;
            }
        }
    });
}

function StateMachine(context, callback, fn, task_fn) {

    this.state = new State();
    this.fn = fn;
    this.task_fn = task_fn;
    this.context = context;
    this.finalCallback = callback;

    // The following two will be initialized if the body
    // of the state machine contains a finally {} block.
    // If not, they can remain null.
    this.captureStateVars = null; // Might be initialized to function () { return array; }
    this.restoreStateVars = null; // Might be initialized to function (array) { assign state variables; }

    this.boundStep = this.step.bind(this);
    this.boundUnwind = this.unwind.bind(this);
    this.controlAPIMaker = controlAPIMaker.bind(this);

    // Initialize the jump table structure if not done already.
    this.task_fn.cachedJumpTable = this.task_fn.cachedJumpTable || {};

    return this;
}

StateMachine.prototype.start = function () {
    this.goTo(1);
};

StateMachine.prototype.step = function () {
    this.state.waiting--;
    if (this.state.abort_with_error) {
        this.performAbort();
    } else {
        this.fn.apply(this.context, this.state.args);
    }
};

// If an abortion has been requested by the state machine
// user, then bail out on the next step.
StateMachine.prototype.performAbort = function () {
    var err = this.state.abort_with_error;
    this.state.abort_with_error = null;
    this.fn.call(this.context, err);
};

StateMachine.prototype.goTo = function (id) {
    this.state.id = id;
    this.state.strict_unwind = false;
    this.state.waiting++;
    nextTick(this.boundStep);
};

StateMachine.prototype.thenTo = function (id) {
    var done = false;
    var self = this;
    this.state.waiting++;
    return function () {
        var _self = self;
        var _state = _self.state;
        _state.waiting--;
        if (!done) {
            done = true;
            _state.id = id;
            if (_state.abort_with_error) {
                _self.performAbort();
            } else {
                _self.fn.apply(_self.context, arguments); 
            }
        } else {
            console.error('Callback called repeatedly!');
        }
    };
};

StateMachine.prototype.thenToWithErr = function (id) {
    var done = false;
    var self = this;
    this.state.waiting++;
    return function (err, result) {
        var _self = self;
        var _state = _self.state;
        _state.waiting--;
        if (!done) {
            done = true;
            _state.id = id;
            if (_state.abort_with_error) {
                _self.performAbort();
            } else if (arguments.length <= 2) {
                // Slightly more efficient in the common case.
                _self.fn.call(_self.context, null, err, result);
            } else {
                var argv = Array.prototype.slice.call(arguments, 0);
                argv.unshift(null); // Push the err argument to the explicit range.
                _self.fn.apply(_self.context, argv); 
            }
        } else {
            console.error('Callback called repeatedly!');
        }
    };
};

// StateMachine supports a single global error notification point.
// You can set StateMachine.onerror to an error callback function that
// will be called asynchronously with two arguments - the error and 
// the state machine instance within which the error was raised.
// You can use this, for example, to log all such errors.
//
// If this callback is to process an error and err is an instance of
// Error, then an additional '.cspjsStack' property is added. This
// property is an array to which more context will get added as the
// error bubbles up. Each context is expressed in the form -
//     task_fn_name:<id>
// where "task_fn_name" is the given name of the async task (so yeah,
// better name your tasks if you want this to be useful) and "id"
// gives the state id responsible for the error. In the case of
// errors raised by "throw", this will refer to the state id immediately
// before the throw.
//
// To locate the specified state, look into the compiled source for
// a "case <id>:" statement under the task named task_fn_name.
// Gathering context this way permits errors to be traced even in 
// reorganized code, where source context may or may not be available,
// or JS code may not be stored in files at all.
//
// The overhead of this error context accumulation occurs only at 
// error propagation time and almost no cost is added to normal
// control flow.
StateMachine.prototype.callback = function (err) {
    this.state.args = Array.prototype.slice.call(arguments);
    this.state.err = err;
    this.state.strict_unwind = true;
    if (err && err instanceof Error) {
        err.cspjsStack = err.cspjsStack || [];
        err.cspjsStack.push((this.task_fn.name || 'unnamed') + ':' + (this.state.id-1));
    }
    err && StateMachine.onerror && nextTick(StateMachine.onerror, err, this);
    nextTick(this.boundUnwind);
};

StateMachine.prototype.windTo = function (step) {
    this.state.isUnwinding = false;
    this.goTo(step);
};

StateMachine.prototype.unwind = function () {
    if (this.state.unwinding.length > 0) {
        var where = this.state.unwinding.pop();
        this.state.isUnwinding = true;
        if (where.restoreState) {
            this.restoreStateVars(where.restoreState);
            this.unwind();
        } else if (where.retry) {
            this.windTo(where.retry);
        } else if (where.phi) {
            if (this.state.err || this.state.strict_unwind) {
                // If we're strictly unwinding, then regular phi control flow doesn't apply.
                nextTick(this.boundUnwind);
            } else {
                // Normal phi jump.
                this.windTo(where.phi);
            }
        } else if (where.isError) {
            if (this.state.err) {
                this.state.currentErrorStep = where;
                this.goTo(where.step);
            } else {
                nextTick(this.boundUnwind);
            }
        } else {
            if (where.fn) {
                where.fn();
                nextTick(this.boundUnwind);
            } else {
                this.beginCleanup(where.state);
                this.goTo(where.step);
            }
        }
    } else if (!this.state.isFinished) {
        this.state.waiting = 0;
        this.state.isFinished = true;
        this.finalCallback && this.finalCallback.apply(this.context, this.state.args);
    }
};

StateMachine.prototype.pushCleanupAction = function (context, fn, args) {
    var self = this;
    self.state.unwinding.push({
        cleanup: true,
        fn: function () {
            fn.apply(context, args);
        }
    });
};

StateMachine.prototype.pushCleanupStep = function (id, afterID) {
    this.state.unwinding.push({cleanup: true, step: id, state: this.captureStateVars()});
    this.goTo(afterID);
};

StateMachine.prototype.pushErrorStep = function (id, retryID) {
    this.state.unwinding.push({isError: true, step: id, retryStep: retryID, unwindPoint: this.state.unwinding.length});
    this.goTo(retryID);
};

StateMachine.prototype.beginCleanup = function (state) {
    this.state.unwinding.push({restoreState: this.captureStateVars()});
    this.restoreStateVars(state);
};

// Retry will place the error handler again on the error stack
// and jump to the beginning of the code block that previously
// generated the error. Presumably, some corrective actions have
// been taken already.
StateMachine.prototype.retry = function () {
    if (!this.state.currentErrorStep) {
        throw new Error('SyntaxError: retry statement can only be used within catch blocks');
    }

    var errorStep = this.state.currentErrorStep;

    // Finally clauses might need to run between the start of the error handler
    // and the current retry statement. So we need to unwind through the
    // finally clauses before stepping out of the catch block. To do this,
    // insert a plain jump into the unwind sequence at the appropriate
    // point. And of course, we also restore the error step description
    // object on the unwind stack so that the surrounding catch block will
    // attempt to handle any new errors that may occur.
    this.state.unwinding.splice(errorStep.unwindPoint, 0, errorStep, {retry: errorStep.retryStep});

    // Enter a "no error" state.
    this.state.currentErrorStep = null;
    this.state.args = Array.prototype.slice.call(arguments);
    this.state.args.unshift(null);
    this.state.err = null;
    this.state.strict_unwind = true;

    // Begin unwinding through the finallies.
    this.phi();
};

// A note on semantics. phi used to be a separate stack, which meant
// that finally blocks that occur within while loops would all execute
// at the end of the while loop only. This is, in general, not desirable
// and it is useful to have the finally code executed once for each
// scope. For this reason, it is better to have the same unwinding
// stack also handle the phi jumps so that error handling code gets
// to run as soon as possible.
//
// Currently, if-then-else, while and switch blocks all delimit scopes
// for execution of finally handlers.

StateMachine.prototype.pushPhi = function (id, captureState) {
    this.state.unwinding.push({phi: id, state: (captureState ? this.captureStateVars() : null)});
};

StateMachine.prototype.phi = function () {
    nextTick(this.boundUnwind);
};

function JumpTable(id, cases, blockSizes) {
    this.id = id;
    this.cases = cases;
    this.blockSizes = blockSizes;
    this.stepIDs = [];
    this.beyondID = id;

    var i = 0, j = 0, sum = id + 1, ci;
    for (i = 0; i < blockSizes.length; ++i) {
        ci = cases[i];
        for (j = 0; j < ci.length; ++j) {
            this.stepIDs[ci[j]] = sum;
        }
        sum += 1 + blockSizes[i]; // +1 for the additional "phi"
    }

    this.beyondID = sum;
    return this;
}

JumpTable.prototype.jumpToCase = function (sm, caseVal) {
    sm.pushPhi(this.beyondID);
    var stepID = this.stepIDs[caseVal];
    if (!stepID) {
        throw new Error("Unhandled case '" + caseVal + "' at step " + this.id);
    }
    sm.goTo(stepID);
};

StateMachine.prototype.jumpTable = function (id, cases, blockSizes) {
    // cases[i] is an array of case values that all map
    // to the same block whose size is given by blockSizes[i].
    if (!cases) {
        return this.task_fn.cachedJumpTable[id];
    }

    console.assert(cases.length === blockSizes.length);

    return (this.task_fn.cachedJumpTable[id] = new JumpTable(id, cases, blockSizes));
};

StateMachine.prototype.channel = function () {
    return new Channel();
};

StateMachine.prototype.resolve = Channel.resolve;

module.exports = StateMachine;
