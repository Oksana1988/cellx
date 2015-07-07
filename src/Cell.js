(function() {
	var nextTick = cellx.nextTick;
	var EventEmitter = cellx.EventEmitter;

	var error = {
		original: null
	};

	var currentlyRelease = false;

	/**
	 * @type {Array<?Array<cellx.Cell>>}
	 */
	var releasePlan = [];

	var releasePlanIndex = 0;
	var maxLevel = -1;

	var calculatedCell = null;

	var releaseVersion = 1;

	function release() {
		if (releasePlanIndex > maxLevel) {
			return;
		}

		currentlyRelease = true;

		do {
			var bundle = releasePlan[releasePlanIndex];

			if (bundle) {
				var cell = bundle.shift();

				if (releasePlanIndex) {
					cell._recalc();
				} else {
					cell._changed = true;

					if (cell._events.change) {
						cell.emit(cell._changeEvent);
					}

					cell._fixedValue = cell._value;
					cell._changeEvent = null;

					var slaves = cell._slaves;

					for (var i = slaves.length; i;) {
						var slave = slaves[--i];

						if (slave._fixed) {
							(releasePlan[1] || (releasePlan[1] = [])).push(slave);

							if (!maxLevel) {
								maxLevel = 1;
							}

							slave._fixed = false;
						}
					}
				}

				if (releasePlan[releasePlanIndex].length) {
					continue;
				} else {
					releasePlan[releasePlanIndex] = null;
				}
			}

			releasePlanIndex++;
		} while (releasePlanIndex <= maxLevel);

		maxLevel = -1;

		releaseVersion++;

		currentlyRelease = false;
	}

	/**
	 * @class cellx.Cell
	 * @extends {cellx.EventEmitter}
	 *
	 * @example
	 * var a = new Cell(1);
	 * var b = new Cell(2);
	 * var c = new Cell(function() {
	 *     return a.read() + b.read();
	 * });
	 *
	 * c.on('change', function() {
	 *     console.log('c = ' + c.read());
	 * });
	 *
	 * console.log(c.read());
	 * // => 3
	 *
	 * a.write(5);
	 * b.write(10);
	 * // => 'c = 15'
	 *
	 * @typesign new (value?, opts?: {
	 *     owner?: Object,
	 *     read?: (value): *,
	 *     validate?: (value): *,
	 *     onchange?: (evt: cellx~Event): boolean|undefined,
	 *     onerror?: (evt: cellx~Event): boolean|undefined,
	 *     computed?: false
	 * }): cellx.Cell;
	 *
	 * @typesign new (formula: (): *, opts?: {
	 *     owner?: Object,
	 *     read?: (value): *,
	 *     write?: (value),
	 *     validate?: (value): *,
	 *     onchange?: (evt: cellx~Event): boolean|undefined,
	 *     onerror?: (evt: cellx~Event): boolean|undefined,
	 *     computed?: true
	 * }): cellx.Cell;
	 */
	function Cell(value, opts) {
		EventEmitter.call(this);

		if (!opts) {
			opts = {};
		}

		this.owner = opts.owner || null;

		this.computed = typeof value == 'function' &&
			(opts.computed !== undefined ? opts.computed : value.constructor == Function);

		this._value = undefined;
		this._fixedValue = undefined;
		this.initialValue = undefined;
		this._formula = null;

		this._read = opts.read || null;
		this._write = opts.write || null;

		this._validate = opts.validate || null;

		/**
		 * Ведущие ячейки.
		 * @type {?Array<cellx.Cell>}
		 */
		this._masters = null;
		/**
		 * Ведомые ячейки.
		 * @type {Array<cellx.Cell>}
		 */
		this._slaves = [];

		/**
		 * @type {uint|undefined}
		 */
		this._level = 0;

		this._changeEvent = null;
		this._isChangeCancellable = true;

		this._fixed = true;

		this._lastErrorEvent = null;

		this._circularityCounter = 0;

		this._version = 0;

		this._active = false;

		this._changed = false;

		if (this.computed) {
			this._formula = value;
			this._activate();
		} else {
			if (this._validate) {
				this._validate.call(this.owner || this, value);
			}

			this._value = this._fixedValue = this.initialValue = value;

			if (value instanceof EventEmitter) {
				value.on('change', this._onValueChange, this);
			}
		}

		if (opts.onchange) {
			this.on('change', opts.onchange);
		}
		if (opts.onerror) {
			this.on('error', opts.onerror);
		}
	}
	extend(Cell, EventEmitter);

	assign(Cell.prototype, {
		/**
		 * @typesign (): boolean;
		 */
		changed: function() {
			if (!currentlyRelease) {
				release();
			}

			return this._changed;
		},

		/**
		 * @override cellx.EventEmitter#on
		 */
		on: function(type, listener, context) {
			if (!currentlyRelease) {
				release();
			}

			if (this.computed && !this._events.change && !this._slaves.length) {
				this._activate();
			}

			EventEmitter.prototype.on.call(this, type, listener, context);

			return this;
		},
		/**
		 * @override cellx.EventEmitter#off
		 */
		off: function(type, listener, context) {
			if (!currentlyRelease) {
				release();
			}

			EventEmitter.prototype.off.call(this, type, listener, context);

			if (this.computed && !this._events.change && !this._slaves.length) {
				this._deactivate();
			}

			return this;
		},

		/**
		 * @override cellx.EventEmitter#_on
		 */
		_on: function(type, listener, context) {
			EventEmitter.prototype._on.call(this, type, listener, context || this.owner);
		},
		/**
		 * @override cellx.EventEmitter#_off
		 */
		_off: function(type, listener, context) {
			EventEmitter.prototype._off.call(this, type, listener, context || this.owner);
		},

		/**
		 * @typesign (listener: (err: Error, evt: cellx~Event): boolean|undefined): cellx.Cell;
		 */
		subscribe: function(listener) {
			function wrap(evt) {
				return listener.call(this, evt.error || null, evt);
			}
			wrap[KEY_INNER] = listener;

			this
				.on('change', wrap)
				.on('error', wrap);

			return this;
		},
		/**
		 * @typesign (listener: (err: Error, evt: cellx~Event): boolean|undefined): cellx.Cell;
		 */
		unsubscribe: function(listener) {
			this
				.off('change', listener)
				.off('error', listener);

			return this;
		},

		/**
		 * @typesign (slave: cellx.Cell);
		 */
		_registerSlave: function(slave) {
			if (this.computed && !this._events.change && !this._slaves.length) {
				this._activate();
			}

			this._slaves.push(slave);
		},
		/**
		 * @typesign (slave: cellx.Cell);
		 */
		_unregisterSlave: function(slave) {
			this._slaves.splice(this._slaves.indexOf(slave), 1);

			if (this.computed && !this._events.change && !this._slaves.length) {
				this._deactivate();
			}
		},

		/**
		 * @typesign ();
		 */
		_activate: function() {
			if (this._version != releaseVersion) {
				this._masters = null;
				this._level = 0;

				var value = this._tryFormula();

				if (value === error) {
					this._handleError(error.original);
				} else {
					this._value = value;
				}

				this._version = releaseVersion;
			}

			var masters = this._masters || [];

			for (var i = masters.length; i;) {
				masters[--i]._registerSlave(this);
			}

			this._active = true;
		},
		/**
		 * @typesign ();
		 */
		_deactivate: function() {
			var masters = this._masters;

			for (var i = masters.length; i;) {
				masters[--i]._unregisterSlave(this);
			}

			this._active = false;
		},

		/**
		 * @typesign (evt: cellx~Event);
		 */
		_onValueChange: function(evt) {
			if (this._changeEvent) {
				evt.prev = this._changeEvent;

				this._changeEvent = evt;

				if (this._value === this._fixedValue) {
					this._isChangeCancellable = false;
				}
			} else {
				(releasePlan[0] || (releasePlan[0] = [])).push(this);

				releasePlanIndex = 0;

				if (maxLevel == -1) {
					maxLevel = 0;
				}

				evt.prev = null;

				this._changeEvent = evt;
				this._isChangeCancellable = false;

				if (!currentlyRelease) {
					nextTick(release);
				}
			}
		},

		/**
		 * @typesign (): *;
		 */
		read: function() {
			if (calculatedCell) {
				if (calculatedCell._masters) {
					if (calculatedCell._masters.indexOf(this) == -1) {
						calculatedCell._masters.push(this);

						if (calculatedCell._level <= this._level) {
							calculatedCell._level = this._level + 1;
						}
					}
				} else {
					calculatedCell._masters = [this];
					calculatedCell._level = this._level + 1;
				}
			}

			if (!currentlyRelease) {
				release();
			}

			if (this.computed && !this._active && this._version != releaseVersion) {
				this._masters = null;
				this._level = 0;

				var value = this._tryFormula();

				if (value === error) {
					this._handleError(error.original);
				} else {
					var oldValue = this._value;

					if (!is(oldValue, value)) {
						this._value = value;
						this._changed = true;
					}
				}

				this._version = releaseVersion;
			}

			return this._read ? this._read.call(this.owner || this, this._value) : this._value;
		},

		/**
		 * @typesign (value): boolean;
		 */
		write: function(value) {
			if (this.computed && !this._write) {
				throw new TypeError('Cannot write to read-only cell');
			}

			var oldValue = this._value;

			if (is(oldValue, value)) {
				return false;
			}

			if (this._validate) {
				this._validate.call(this.owner || this, value);
			}

			if (this.computed) {
				this._write.call(this.owner || this, value);
			} else {
				this._value = value;

				if (oldValue instanceof EventEmitter) {
					oldValue.off('change', this._onValueChange, this);
				}
				if (value instanceof EventEmitter) {
					value.on('change', this._onValueChange, this);
				}

				if (this._changeEvent) {
					if (is(value, this._fixedValue) && this._isChangeCancellable) {
						if (releasePlan[0].length == 1) {
							releasePlan[0] = null;
						} else {
							releasePlan[0]._unregisterSlave(this);
						}

						this._changeEvent = null;
					} else {
						this._changeEvent = {
							target: this,
							type: 'change',
							oldValue: oldValue,
							value: value,
							prev: this._changeEvent
						};
					}
				} else {
					(releasePlan[0] || (releasePlan[0] = [])).push(this);

					releasePlanIndex = 0;

					if (maxLevel == -1) {
						maxLevel = 0;
					}

					this._changeEvent = {
						target: this,
						type: 'change',
						oldValue: oldValue,
						value: value,
						prev: null
					};
					this._isChangeCancellable = true;

					if (!currentlyRelease) {
						nextTick(release);
					}
				}
			}

			return true;
		},

		/**
		 * @typesign ();
		 */
		_recalc: function() {
			if (this._version == releaseVersion) {
				if (++this._circularityCounter == 10) {
					this._version = releaseVersion + 1;
					this._handleError(new RangeError('Circular dependency detected'));
					return;
				}
			} else {
				this._circularityCounter = 1;
			}

			var oldMasters = this._masters;
			this._masters = null;

			var oldLevel = this._level;
			this._level = 0;

			var value = this._tryFormula();

			var masters = this._masters || [];
			var haveRemovedMasters = false;

			for (var i = oldMasters.length; i;) {
				var oldMaster = oldMasters[--i];

				if (masters.indexOf(oldMaster) == -1) {
					oldMaster._unregisterSlave(this);
					haveRemovedMasters = true;
				}
			}

			if (haveRemovedMasters || oldMasters.length < masters.length) {
				for (var j = masters.length; j;) {
					var master = masters[--j];

					if (oldMasters.indexOf(master) == -1) {
						master._registerSlave(this);
					}
				}

				var level = this._level;

				if (level > oldLevel) {
					(releasePlan[level] || (releasePlan[level] = [])).push(this);

					if (maxLevel < level) {
						maxLevel = level;
					}

					return;
				}
			}

			if (value === error) {
				this._handleError(error.original);
			} else {
				var oldValue = this._value;

				if (!is(oldValue, value)) {
					this._value = value;
					this._changed = true;

					if (this._events.change) {
						this.emit({
							type: 'change',
							oldValue: oldValue,
							value: value,
							prev: null
						});
					}

					this._fixed = true;

					var slaves = this._slaves;

					for (var k = slaves.length; k;) {
						var slave = slaves[--k];

						if (slave._fixed) {
							var lvl = slave._level;

							(releasePlan[lvl] || (releasePlan[lvl] = [])).push(slave);

							if (maxLevel < lvl) {
								maxLevel = lvl;
							}

							slave._fixed = false;
						}
					}
				}
			}

			this._version = releaseVersion + 1;
		},

		/**
		 * @typesign (): *;
		 */
		_tryFormula: function() {
			var prevCalculatedCell = calculatedCell;
			calculatedCell = this;

			try {
				var value = this._formula.call(this.owner || this);

				if (this._validate) {
					this._validate.call(this.owner || this, value);
				}

				return value;
			} catch (err) {
				error.original = err;
				return error;
			} finally {
				calculatedCell = prevCalculatedCell;
			}
		},

		/**
		 * @typesign (err: Error);
		 */
		_handleError: function(err) {
			this._handleErrorEvent({
				type: 'error',
				error: err
			});
		},

		/**
		 * @typesign (evt: cellx~Event);
		 */
		_handleErrorEvent: function(evt) {
			if (this._lastErrorEvent === evt) {
				return;
			}

			this._lastErrorEvent = evt;

			this.emit(evt);

			var slaves = this._slaves;

			for (var i = slaves.length; i;) {
				if (evt.isPropagationStopped === true) {
					break;
				}

				slaves[--i]._handleErrorEvent(evt);
			}
		},

		/**
		 * @typesign (): cellx.Cell;
		 */
		dispose: function() {
			if (!currentlyRelease) {
				release();
			}

			this._dispose();

			return this;
		},

		/**
		 * @typesign ();
		 */
		_dispose: function() {
			this.off();

			if (this._active) {
				var slaves = this._slaves;

				for (var i = slaves.length; i;) {
					slaves[--i]._dispose();
				}
			}
		}
	});

	cellx.Cell = Cell;
})();
