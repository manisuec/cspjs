// A channel is a queue with a read-end and a write-end.
// Values are written and read asynchronously via callbacks.
// The basic channel is such that the callback associated
// with a value put into it will be called when the value
// is consumed from the read end.

var nextTick = (function () {
    return this.setImmediate || process.nextTick;
}());

function Channel() {
    this._queue = new Array;
    this._pending = new Array;
    return this;
}

// Convenience class method to instantiate a channel.
Channel.new = function () {
    return new Channel();
};

function sendValue(value, callback) {
    callback && nextTick(function () { callback(null, value); });
}

function sendError(err, callback) {
    callback && nextTick(function () { callback(err, null); });
}

function sendValueS(value, callback) {
    callback && callback(null, value);
}

function sendErrorS(err, callback) {
    callback && callback(err, null);
}

function CBV(callback, value) {
    this._callback = callback;
    this._value = value;
    return this;
}

// Read a value from the channel, passing the value to the given callback.
Channel.prototype.take = function (callback) {
    if (this._queue.length > 0) {
        var q = this._queue.shift();
        sendValue(q._value, q._callback);
        sendValue(q._value, callback);
    } else {
        callback && this._pending.push(callback);
    }
};

// Places a value into the channel. The callback will be called when the value is
// consumed from the read-end.
Channel.prototype.put = function (value, callback) {
    if (this._pending.length > 0) {
        var p = this._pending.shift();
        sendValue(value, callback);
        sendValue(value, p);
    } else {
        this._queue.push(new CBV(callback, value));
    }
};

// Does any ending actions on the channel.
// The protocol is to have a channel "end"
// by a null value being placed on it. The
// end() method is simply to perform any pending 
// ending actions. The default action is to replace
// the end() function with the original end.
Channel.prototype.end = function end() {
    this.end = end;
};

// Returns a channel that will give you values that come
// on this channel, without actually reading from the channel.
// That is, multiple taps on a channel will get its values
// fanned out. If a channel argument is given, the tapped
// values will go into that channel.
Channel.prototype.tap = function (chan) {
    var tapChan = chan || new Channel();
    var self = this;
    if (!this._taps) {
        this._taps = [tapChan];
        var put = this.put;
        this.put = function (value, callback) {
            for (var c = 0, cN = this._taps.length; c < cN; ++c) {
                this._taps[c].put(value);
            }
            if (value === null) {
                while (this._taps.length > 0) {
                    this._taps[0].end();
                }
                this._taps = null;
                this.put = put;
            }
            if (this._pending.length > 0) {
                // Put only if there are takers. Otherwise
                // just drop the value. If we don't do this,
                // the value will simply pile up if only taps
                // are being used on the channel.
                put.call(this, value, callback);
            }
        };
    } else {
        this._taps.push(tapChan);
    }

    var end = tapChan.end;
    tapChan.end = function () {
        self._taps.splice(self._taps.indexOf(tapChan), 1);
        end.call(this);
    };
    return tapChan;
};


// For an end-point channel, applies the given
// function to values received on the channel.
// The second argument to the function is a callback
// that should be called once the processing has completed.
// It is alright to call the callback synchronously.
// It only makes sense to have one processing function
// for a channel. The fn is called with the value as the
// first argument and a loop continuation callback as
// the second argument.
Channel.prototype.process = function (fn) {
    var self = this;
    function receive(err, value) {
        fn(value, loop);
    }
    function loop(err) {
        if (!err) {
            self.take(receive);
        }
    }
    loop(null);
    return this;
};

// Binds a channel to the given named method of the given
// class. If the class has an init() method, it will be called
// with `options.initArgs` to instantiate an object.
// The given `options.methodName` of the resultant object will be 
// invoked with the message as the first argument, and a continuation
// callback (a la `process()`) as the second argument. The methodName
// defaults to `receive`.
//
// If `options.spawn` is `true`, then the handler is called with the
// message only and the channel returns to processing other
// messages immediately without waiting for the handling to
// finish.
//
// Calling bind on an already bound channel replaces the previous binding.
Channel.prototype.bind = function (klass, options) {
    var self = this, receive, loop;
    self._boundClass = klass;
    self._boundMethodName = (options && options.methodName) || 'receive';
    self._boundInitArgs = (options && options.initArgs) || [];
    self._boundSpawn = (options && options.spawn) || false;
    if (!self._bound) {
        receive = function (err, msg) {
            var handler = new self._boundClass(); // new is not expected to throw.
            if (handler.init) {
                try {
                    handler = handler.init.apply(handler, self._boundInitArgs);
                } catch (e) {
                    return loop(err);
                }
            }
            if (self._boundSpawn) {
                nextTick(loop);
                handler[self._boundMethodName](msg);
            } else {
                handler[self._boundMethodName](msg, loop);
            }
        };
        loop = function (err) {
            if (!err) {
                self.take(receive);
            } else {
                self._bound = false;
            }
        };
        self._bound = true;
        loop(null);
    }
    return this;
};

function ChannelValue(chan, err, value) {
    this.chan = chan;
    this.err = err;
    this.val = value;
    return this;
}

ChannelValue.prototype.resolve = function () {
    if (this.err) {
        throw this.err;
    } else {
        return this.val;
    }
};

// Makes a callback that will receive the value produced by
// some process and place the result into the channel. The
// "id" exists to identify the one producing the value.
// The "id", "err" and "val" are all available on the
// channel.
Channel.prototype.receive = function () {
    var self = this;
    return function (err, value) {
        self.put(new ChannelValue(self, err, value));
    };
};

// Like receive, but results in the channel being 'filled'
// with the value received on the callback. Once a value
// is received, all subsequent take operations will give
// the same value, and puts will result in an error.
Channel.prototype.resolver = function () {
    var self = this;
    return function (err, value) {
        self.fill(new ChannelValue(self, err, value));
    };
};

// Answers "will read succeed immediately?"
Channel.prototype.canRead = function () {
    return this._queue.length > 0 && this._pending.length === 0;
};

// Answers "will write succeed immediately?"
Channel.prototype.canWrite = function () {
    return this._pending.length > 0 || this._queue.length === 0;
};

// Answers "how many values have been placed into the channel?"
// Positive values give the number of values available right away.
// Negative values give the number of pending take operations.
Channel.prototype.backlog = function () {
    return this._queue.length - this._pending.length;
};

// Makes a new channel whose values are transformed by the given
// function "f". `cond(value)` is a function that specifies a 
// condition until which the mapping will continue. The mapper
// is not expected to throw.
Channel.prototype.map = function (f) {
    var ch2 = Object.create(this);
    var take = this.take;
    ch2.take = function (callback) {
        take.call(this, function (err, value) {
            callback(err, err ? null : f(value));
        });
    };
    return ch2;
};

// Makes a new channel and pipes the values in this
// channel to it. Only the values that satisfy the
// predicate function 'f' are piped and others
// are dropped. The filter function is not expected
// to throw.
Channel.prototype.filter = function (f) {
    var ch2 = Object.create(this);
    var take = this.take;
    ch2.take = function (callback) {
        take.call(this, function (err, value) {
            if (err) { 
                callback(err, null); 
            } else if (f(value)) {
                callback(err, value);
            } else {
                ch2.take(callback); // Value dropped
            }
        });
    };
    return ch2;
};

// Makes a new channel, reduces the values produced
// continuously and sends the output to the taker.
// The reducer is not expected to throw.
Channel.prototype.reduce = function (initial, f) {
    var ch2 = Object.create(this);
    var take = this.take;
    var result = initial;
    ch2.take = function (callback) {
        take.call(this, function (err, value) {
            if (err) {
                callback(err, null);
            } else {
                result = f(result, value);
                callback(null, result);
            }
        });
    };
    return ch2;
};

// Makes a new channel and pipes the values put into this
// channel in groups of N. 
Channel.prototype.group = function (N) {
    if (N <= 0) {
        throw new Error('Groups need to be at least 1 in size. Given "' + N + '"');
    }
    return this.reduce([], function (group, value) {
        return (group.length === N) ? [value] : (group.push(value), group);
    }).filter(function (g) { return g.length === N; });
};

function resolve(thing, recursive, callback) {
    var unresolved = 0;

    if (thing instanceof Channel) {
        unresolved += resolveChannel(thing, recursive, callback);
    } else if (thing instanceof Array) {
        unresolved += resolveArray(thing, recursive, callback);
    } else if (thing instanceof Object) {
        unresolved += resolveObject(thing, recursive, callback);
    } else {
        sendValue(thing, callback);
    }

    return unresolved;
}

function resolveChannel(channel, recursive, callback) {
    if (recursive) {
        channel.take(function receiver(err, value) {
            Channel.resolve(value, recursive, callback);
        });
    } else {
        channel.take(callback);
    }

    return 1;
}

function resolveArray(arr, recursive, callback) {
    var unresolved = 0;

    for (var i = 0; i < arr.length; ++i) {
        unresolved += resolve(arr[i], recursive, (function (i) {
            return function receiver(err, value) {
                if (recursive) {
                    resolve(value, recursive, receiver);
                } else {
                    arr[i] = value;
                    --unresolved;
                    if (unresolved === 0) {
                        callback(null, arr);
                    }
                }
            };
        }(i)));
    }

    return unresolved;
}

function resolveObject(obj, recursive, callback) {
    unresolved = 0;
    Object.keys(obj).forEach(function (k) {
        unresolved += resolve(obj[k], recursive, function receiver(err, value) {
            if (recursive) {
                resolve(value, recursive, receiver);
            } else {
                obj[k] = value;
                --unresolved;
                if (unresolved === 0) {
                    callback(null, obj);
                }
            }
        });
    });
    return unresolved;
}

// Waits for all channels in the given array to get a value,
// replaces the array element with the received value and calls
// back when all entries have been resolved. If 'recursive' is
// true, then if the value received on a channel is itself a channel,
// it is recursively waited on until final resolution.
Channel.resolve = resolve;

// Temporarily switches the channel to a mode where it will
// collect the next N items into a group and pass it on to
// the callback.
//
// Use within task like this -
//      var ch = new Channel();
//      ...
//      x <- ch.takeN(10);
Channel.prototype.takeN = function (N, callback) {
    var group = [];
    var self = this;
    function receive(err, value) {
        if (err) {
            return sendError(err, callback);
        }
        if (value !== null) {
            group.push(value);
            if (group.length < N) {
                self.take(receive);
            } else {
                sendValue(group, callback);
            }
        } else {
            sendValue(group, callback);
        }
    }
    self.take(receive);
};

// Takes as many values as it can without blocking.
Channel.prototype.takeSome = function (callback) {
    var bl = this.backlog();
    if (bl > 0) {
        return this.takeN(bl, callback);
    }
    sendValue([], callback);
};

// Keeps this channel alive until a value is
// received from the given chan.
Channel.prototype.until = function (chan) {
    var done = false;
    var self = this;
    var tapChan = chan.tap();
    tapChan.take(function (err, value) {
        done = true;
        tapChan.end();
        self.end();
    });
    var ch = this.tap();
    var take = ch.take;
    ch.take = function (callback) {
        if (done) {
            sendValue(null, callback);
        } else {
            take.call(this, callback);
        }
    };
    return ch;
};

function noop() {}

// Switches the channel to a state where every time some
// reader takes a value from the channel, they'll get
// `value` delivered immediately. This makes a channel
// behave somewhat like a promise, where until `fill`
// is called, asking for a value will cause a wait, but
// once `fill` is called somewhere, `take` will always
// succeed with a single value.
Channel.prototype.fill = function (value) {
    if (this.backlog() > 0) {
        throw new Error('Channel::fill cannot be used after Channel::put has been called');
    }

    var origPut = this.put;

    this.take = function (callback) {
        sendValue(value, callback);
    };
    this.put = function (ignoredValue, callback) {
        sendError('filled', callback);
    };
    this.fill = noop;

    // If takers are already waiting, satisfy them
    // immediately.
    while (this.backlog() < 0) {
        origPut.call(this, value);
    }

    return this;
};

// Sends the elements of the given array one by one
// to the channel as readers request values. The
// callback will be called when the last value is
// accepted.
Channel.prototype.stream = function (array, callback) {
    var i = 0, self = this;
    function next() {
        if (i < array.length) {
            self.put(array[i++], next);
        } else {
            sendValue(array, callback);
        }
    }
    next();
};

// Sets up the channel to receive events of the given type
// from the given domElement. (Works only in the browser.)
// `domElement` can either be a string which is taken to be
// a querySelector specifier, an array of DOM nodes, or
// a single DOM node. `eventName` is a string like 'click'
// which gives an event category to bind to.
//
// Note: If you want a channel to not receive events
// too frequently, you can first debounce the channel
// before listening for events, like this -
//
//      ch = new Channel();
//      ch.debounce(100).listen('.textarea', 'change');
//
// The above code will make sure that consecutive change 
// events are separated by at least 100ms. The debounce()
// method call produces a wrapper channel object that
// acts as a gatekeeper to the original channel object
// 'ch'. So, while the above way will result in debounced
// actions, you can subsequently call `ch.listen()` to
// bypass debouncing on the same channel. Readers reading
// `ch` will receive events from the debounced elements
// as well from the elements bound directly.
Channel.prototype.listen = function (domElement, eventName) {
    var self = this;
    var elements = null;
    if (typeof domElement === 'string') {
        elements = document.querySelectorAll(domElement);
    } else if (domElement.length) {
        elements = domElement;
    } else {
        elements = [domElement];
    }

    function listener(event) {
        self.put(event);
        event.stopPropagation();
    }

    for (var i = 0, N = elements.length; i < N; ++i) {
        elements[i].addEventListener(eventName, listener);
    }

    var end = this.end;
    this.end = function () {
        for (var i = 0, N = elements.length; i < N; ++i) {
            elements[i].removeEventListener(eventName, listener);
        }
        end.call(this);
    };
    return this;
};

// Makes a new channel that receives the values put into
// all the given channels (which is an array of channels).
// The value produced by a merged channel is a wrapper object
// that has three fields - "chan" giving the channel that 
// produced the value, "val" giving the value and "ix" 
// giving the index of the channel in the array that produced
// the value. The merged channel will received a wrapped object
// that will pass on both values as well as errors from the
// channels being merged. This permits custom error handling instead
// of triggering error propagation in the receiver for every
// channel's error. Not all errors and channels need be equal.
//
// Breaking change: MergedChannelValue no longer has an 'ix'
// field giving the index within the array. You need to branch on
// the channel itself. Alternatively, you can store some reference
// value as a property of the channel object any way. The reason
// for this change is that now the "piper" function is exposed
// as the .add() method of the merged channel, to enable addition
// of new channels to the merged stream on the fly. To remove
// a channel from a merged stream, simply send a null value
// to it.
//
// Breaking change: MergedChannelValue is now ChannelValue.
Channel.merge = function (channels) {
    var channel = new Channel();

    function piper(ch) {
        function writer(err, value) {
            if (value !== null) {
                channel.put(new ChannelValue(ch, err, value), reader);
            } else {
                // Indicate that the channel is finished. The reader can discard this.
                channel.put(new ChannelValue(ch, null, null));
            }
        }
        function reader(err, value) {
            ch.take(writer);
        }
        reader(null, true);
    }

    channel.add = piper;
    channels && channels.forEach(piper);

    return channel;
};

// It is sometimes useful to also have a value sent to
// an existing channel after a timeout expires. If some
// other process is supposed to write a value to the
// channel and it is taking too long, the value passed
// to the .timeout() call can be tested against to decide
// whether a timeout occurred before the process could
// do its thing.
Channel.prototype.timeout = function (ms, value) {
    setTimeout(timeoutTick, ms, this, value);
    return this;
};

// Makes a "timeout" channel, which'll deliver a value
// a given interval after the channel is created.
Channel.timeout = function (ms, value) {
    return (new Channel()).timeout(ms, value);
};

function timeoutTick(channel, value) {
    channel.put(value);
}

// Makes a "clock" channel which, once started, will produce
// values counting upwards from `startCounter`, until the
// `stop()` method is called on the channel. Calling `start()`
// will have an effect only when the clock is stopped.
Channel.clock = function (ms) {
    var channel = new Channel();
    channel._timer = null;
    channel._timeInterval_ms = ms;
    channel._counter = 0;
    channel.start = clockStart;
    channel.stop = clockStop;
    return channel;
};

function clockTick(clock) {
    clock.put(clock._counter++);
}

function clockStart(startCounter) {
    if (!this._timer) {
        startCounter = arguments.length < 1 ? 1 : startCounter;
        this._counter = startCounter;
        this._timer = setInterval(clockTick, this._timeInterval_ms, this);
    }
}

function clockStop() {
    if (this._timer) {
        clearInterval(this._timer);
        this._timer = null;
    }
}


// Returns a wrapped interface to channel which will
// debounce the values placed on it - i.e. it will
// reject put() operations that occur within a time
// of "ms" milliseconds between each other.
Channel.prototype.debounce = function (ms) {
    var ch = Object.create(this);
    ch._channel = this;
    ch._debounceInterval_ms = ms;
    ch._timer = null;
    ch.put = debouncingPut;
    return ch;
};

function realPut(ch, value, callback) {
    ch._timer = null;
    ch._channel.put(value, callback);
}

function debouncingPut(value, callback) {
    if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
    }
    this._timer = setTimeout(realPut, this._debounceInterval_ms, this, value, callback);
    return this;
}


// Wraps the given channel with an interface such
// that put() operations will immediately succeed
// as long as fewer than N values have been placed
// on the channel.
Channel.prototype.buffer = function (N) {
    var ch = Object.create(this);
    ch._channel = this;
    ch._bufferLength = N;
    ch.put = bufferedPut;
    ch.take = bufferedTake;
    return ch;
};

function bufferedPut(value, callback) {
    if (this.backlog() < this._bufferLength) {
        this._channel.put(value);
        sendValue(value, callback);
    } else {
        this._channel.put(value, callback);
    }
}

function bufferedTake(callback) {
    this._channel.take(callback);
    if (this.backlog() >= this._bufferLength) {
        var q = this._queue[this._bufferLength - 1];
        sendValue(q._value, q._callback);
        q._callback = null;
    }
}

// Every time a bucket's level falls below the low water mark,
// it waits for the bucket to get full again before delivering
// values to the takers. This is useful when values are expected
// to arrive at a channel roughly periodically, but the rate at 
// which they get processed can fluctuate a bit. The buffering 
// helps with the fluctuation and the "low water mark" helps ensure
// maintenance of the buffer.
Channel.prototype.bucket = function (fullSize, lowWaterMark) {
    var ch = Object.create(this);
    ch._channel = this;
    ch._bufferLength = fullSize;
    ch._bucketLowWaterMark = lowWaterMark || 0;
    ch._suspendedTakes = [];
    ch.waitingTillFull = true;
    ch.take = bucketTake;
    ch.put = bucketPut;
    return ch;
};

function bucketProcSuspendedTakes(bucket) {
    while (bucket._suspendedTakes.length > 0) {
        bufferedTake.call(bucket, bucket._suspendedTakes.shift());
    }
    bucket.waitingTillFull = bucket.backlog() <= bucket._bucketLowWaterMark;
}

function bucketTake(callback) {
    if (this.waitingTillFull) {
        if (this.backlog() > this._bufferLength) {
            // Full reached.
            this.waitingTillFull = false;
            this.take(callback);
        } else {
            this._suspendedTakes.push(callback);
        }
    } else {
        this._suspendedTakes.push(callback);
        bucketProcSuspendedTakes(this);
    }
}

function bucketPut(value, callback) {
    bufferedPut.call(this, value, callback);
    if (this.waitingTillFull) {
        if (this.backlog() > this._bufferLength) {
            // Full reached.
            bucketProcSuspendedTakes(this);
        }
    } else {
        bucketProcSuspendedTakes(this);
    }
}


// If more than N values have been placed into a channel
// and a writer tries to place one more value, sometimes
// we want the new value to be dropped in order that
// processing requirements don't accumulate. This is
// the purpose of `droppingBuffer` which wraps the 
// parent channel's `put` to do this dropping.
//
// A channel with a droppingBuffer will never block a put
// operation.

Channel.prototype.droppingBuffer = function (N) {
    var ch = Object.create(this);
    ch._channel = this;
    ch._bufferLength = N;
    ch.put = droppingPut;
    return ch;
};

function droppingPut(value, callback) {
    if (this.backlog() < this._bufferLength) {
        this._channel.put(value);
        sendValue(value, callback);
    } else {
        // Drop the value.
        sendValue(null, callback);
    }
}

// In the same situation as with `droppingBuffer`,
// at other times, we want the more recent values
// to take precedence over the values already in 
// the queue. In this case, we want to expire the
// old values and replace them with new values.
// That is what `expiringBuffer` does.
//
// A channel with an expiringBuffer will never block a 
// put operation.

Channel.prototype.expiringBuffer = function (N) {
    var ch = Object.create(this);
    ch._channel = this;
    ch._bufferLength = N;
    ch.put = expiringPut;
    return ch;
};

function expiringPut(value, callback) {
    while (this.backlog() >= this._bufferLength) {
        this.take();
    }
    this._channel.put(value);
    sendValue(value, callback);
    return this;
}

// Makes a "fanout" channel that can be "connect()"ed to
// other channels to whom the values that come on this channel
// will be copied. Do not call a fanout channel's "take" method
// explicitly. Instead connect other channels to it to receive
// values. Since it may take time to setup connections, you have
// to call ch.start() explicitly to begin piping values to the
// connections, lest some values get missed out.

Channel.prototype.fanout = function () {
    var ch = Object.create(this);
    ch.connect      = fanoutConnect;
    ch.disconnect   = fanoutDisconnect;
    ch.start        = fanoutStart;
    ch._channel     = this;
    ch._connections = [];
    ch._started     = false;
    return ch;
};

function fanoutConnect() {
    for (var i = 0, N = arguments.length; i < N; ++i) {
        this.disconnect(arguments[i]);
        this._connections.push(arguments[i]);
    }
    return this;
}

function fanoutDisconnect() {
    if (arguments.length === 0) {
        this._connections = [];
        return this;
    }

    var N, i, chan, pos;
    for (i = 0, N = arguments.length; i < N; ++i) {
        chan = arguments[i];
        pos = this._connections.indexOf(chan);
        if (pos >= 0) {
            this._connections.splice(pos, 1);
        }
    }
    return this;
}

function fanoutStart() {
    var self = this;
    if (!self._started) {
        self._started = true;
        self.take(function receive(err, value) {
            if (value !== null) {
                for (var i = 0, N = self._connections.length; i < N; ++i) {
                    self._connections[i].put(value);
                }
                self.take(receive);
            }
        });
    }
    return self;
}

module.exports = Channel;
