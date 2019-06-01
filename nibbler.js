"use strict";

const alert = require("./modules/alert");
const assign_without_overwrite = require("./modules/utils").assign_without_overwrite;
const child_process = require("child_process");
const fs = require('fs');
const ipcRenderer = require("electron").ipcRenderer;
const readline = require("readline");

const fenbox = document.getElementById("fenbox");
const canvas = document.getElementById("canvas");
const infobox = document.getElementById("infobox");
const mainline = document.getElementById("mainline");
const context = canvas.getContext("2d");

const light = "#dadada";
const dark = "#b4b4b4";
const act = "#cc9966";

const log_to_engine = true;
const log_engine_stderr = true;
const log_engine_stdout = false;

// ------------------------------------------------------------------------------------------------

let config = null;
let exe = null;
let scanner = null;
let err_scanner = null;
let readyok_required = false;

function send(msg) {
	try {
		msg = msg.trim();
		exe.stdin.write(msg);
		exe.stdin.write("\n");
		if (log_to_engine) {
			console.log("-->", msg);
		}
	} catch (err) {
		// pass
	}
}

// The sync function exists so that we can disregard all output until a certain point.
// Basically we use it after sending a position, so that we can ignore all analysis
// that comes until LZ sends "readyok" in response to our "isready". All output before
// that moment would refer to the obsolete position.

function sync() {
	send("isready");
	readyok_required = true;
}

// ------------------------------------------------------------------------------------------------

try {
	if (fs.existsSync("config.json")) {
		config = JSON.parse(fs.readFileSync("config.json", "utf8"));
	} else if (fs.existsSync("config.json.example")) {
		config = JSON.parse(fs.readFileSync("config.json.example", "utf8"));
	} else {
		alert("config.json not present");
	}
} catch (err) {
	// pass
}

if (config) {

	// Some tolerable default values for config...

	assign_without_overwrite(config, {
		"options": {},
		"bad_cp_threshold": 20,
		"max_info_lines": 8,
		"node_display_threshold": 0.1,

		"board_size": 640,

		"show_cp": true,
		"show_n": true,
		"show_p": false,
		"show_pv": true,
	});

	infobox.style.height = config.board_size.toString() + "px";
	canvas.width = config.board_size;
	canvas.height = config.board_size;
	
	exe = child_process.spawn(config.path);

	exe.on("error", (err) => {
  		alert("Couldn't spawn process");			// Note that this alert will come some time in the future, not instantly.
	});

	scanner = readline.createInterface({
	    input: exe.stdout,
	    output: undefined,
	    terminal: false
	});

	err_scanner = readline.createInterface({
		input: exe.stderr,
	    output: undefined,
	    terminal: false
	});

	err_scanner.on("line", (line) => {
		if (log_engine_stderr) {
			console.log("!", line);
		}
		renderer.err_receive(line);
	});

	scanner.on("line", (line) => {

		if (log_engine_stdout) {
			console.log("<", line);
		}

		// We want to ignore all output when waiting for readyok

		if (readyok_required) {
			if (line.includes("readyok") === false) {
				return;
			}
			readyok_required = false;
		}

		renderer.receive(line);

	});

	send("uci");

	for (let key of Object.keys(config.options)) {
		send(`setoption name ${key} value ${config.options[key]}`);
	}

	send("setoption name VerboseMoveStats value true");		// Required for LogLiveStats to work.
	send("setoption name LogLiveStats value true");			// "Secret" Lc0 command.
	send("setoption name MultiPV value 500");
	send("ucinewgame");
}

// ------------------------------------------------------------------------------------------------

let images = Object.create(null);
let loads = 0;

for (let c of Array.from("KkQqRrBbNnPp")) {
	images[c] = new Image();
	if (c === c.toUpperCase()) {
		images[c].src = `./pieces/${c}.png`;
	} else {
		images[c].src = `./pieces/_${c.toUpperCase()}.png`;
	}
	images[c].onload = () => {
		loads++;
	};
}

// ------------------------------------------------------------------------------------------------

function XY(s) {
	if (s.length !== 2) {
		return [-1, -1];
	}
	s = s.toLowerCase();
	let x = s.charCodeAt(0) - 97;
	let y = 8 - parseInt(s[1], 10);
	if (x < 0 || x > 7 || y < 0 || y > 7 || Number.isNaN(y)) {
		return [-1, -1];
	}
	return [x, y];
}

function S(x, y) {
	if (typeof x !== "number" || typeof y !== "number" || x < 0 || x > 7 || y < 0 || y > 7) {
		return "??";
	}
	let xs = String.fromCharCode(x + 97);
	let ys = String.fromCharCode((8 - y) + 48);
	return xs + ys;
}

function InfoVal(s, key) {

	// Given some string like "info depth 8 seldepth 22 time 469 nodes 3918 score cp 46 hashfull 13 nps 8353 tbhits 0 multipv 1 pv d2d4 g8f6"
	// pull the value for the key out, e.g. in this example, key "nps" returns "8353" (as a string).

	let tokens = s.split(" ").filter((s) => s !== "");

	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i] === key) {
			return tokens[i + 1];
		}
	}
	return "";
}

function InfoPV(s) {

	// Pull the PV out, assuming it's at the end of the string.

	let tokens = s.split(" ").filter((s) => s !== "");

	for (let i = 0; i < tokens.length - 1; i++) {
		if (tokens[i] === "pv") {
			return tokens.slice(i + 1);
		}
	}
	return "";
}

// ------------------------------------------------------------------------------------------------
// The point of most of this is to make each Point represented by a single object so that
// naive equality checking works, i.e. Point(x, y) === Point(x, y) should be true. Since
// object comparisons in JS will be false unless they are the same object, we do all this...

let all_points = Object.create(null);

for (let x = 0; x < 8; x++) {
	for (let y = 0; y < 8; y++) {
		let s = S(x, y);
		all_points[s] = {x, y, s};
	}
}

let null_point = {x: -1, y: -1, s: "??"};

function Point(a, b) {

	// Point("a8") or Point(0, 0) are both valid.

	let s;

	if (typeof a === "string") {
		s = a;
	} else {
		s = S(a, b);
	}

	let p = all_points[s];

	if (p === undefined) {
		return null_point;
	}

	return p;
}

// ------------------------------------------------------------------------------------------------

function NewInfo() {
	return {
		cp: -999999,
		move: "??",
		multipv: 999,
		n: 1,
		pv: ""
	};
}

function NewPosition(state = null, active = "w", castling = "", enpassant = null, halfmove = 0, fullmove = 1, parent = null, lastmove = null) {

	let p = Object.create(null);
	p.state = [];					// top-left is 0,0

	for (let x = 0; x < 8; x++) {
		p.state.push([]);
		for (let y = 0; y < 8; y++) {
			if (state) {
				p.state[x].push(state[x][y]);
			} else {
				p.state[x].push("");
			}
		}
	}

	p.active = active;
	p.castling = castling;
	
	if (enpassant) {
		p.enpassant = enpassant;
	} else {
		p.enpassant = Point("??");
	}

	p.halfmove = halfmove;
	p.fullmove = fullmove;

	p.parent = parent;
	p.lastmove = lastmove;

	p.copy = () => {
		return NewPosition(p.state, p.active, p.castling, p.enpassant, p.halfmove, p.fullmove, p.parent, p.lastmove);
	};

	p.move = (s) => {

		// s is something like "e2e4".
		// Assumes move is legal - all sorts of weird things can happen if this isn't so.

		let ret = p.copy();
		ret.parent = p;
		ret.lastmove = s;

		let [x1, y1] = XY(s.slice(0, 2));
		let [x2, y2] = XY(s.slice(2, 4));
		let promotion = s.length > 4 ? s[4] : "q";

		let white_flag = p.is_white(Point(x1, y1));
		let pawn_flag = "Pp".includes(ret.state[x1][y1]);
		let capture_flag = ret.state[x2][y2] !== "";

		if (pawn_flag && x1 !== x2) {		// Make sure capture_flag is set even for e.p. captures
			capture_flag = true;
		}

		// Update castling info...

		if (ret.state[x1][y1] === "K") {
			ret.castling = ret.castling.replace("K", "");
			ret.castling = ret.castling.replace("Q", "");
		}

		if (ret.state[x1][y1] === "k") {
			ret.castling = ret.castling.replace("k", "");
			ret.castling = ret.castling.replace("q", "");
		}

		if ((x1 == 0 && y1 == 0) || (x2 == 0 && y2 == 0)) {
			ret.castling = ret.castling.replace("q", "");
		}

		if ((x1 == 7 && y1 == 0) || (x2 == 7 && y2 == 0)) {
			ret.castling = ret.castling.replace("k", "");
		}

		if ((x1 == 0 && y1 == 7) || (x2 == 0 && y2 == 7)) {
			ret.castling = ret.castling.replace("Q", "");
		}

		if ((x1 == 7 && y1 == 7) || (x2 == 7 && y2 == 7)) {
			ret.castling = ret.castling.replace("K", "");
		}

		// Update halfmove and fullmove...

		if (white_flag === false) {
			ret.fullmove++;
		}

		if (pawn_flag || capture_flag) {
			ret.halfmove = 0;
		} else {
			ret.halfmove++;
		}

		// Handle the rook moves of castling...

		if (s === "e1g1") {
			ret.state[5][7] = "R";
			ret.state[7][7] = "";
		}

		if (s === "e1c1") {
			ret.state[3][7] = "R";
			ret.state[0][7] = "";
		}

		if (s === "e8g8") {
			ret.state[5][0] = "r";
			ret.state[7][0] = "";
		}

		if (s === "e8c8") {
			ret.state[3][0] = "r";
			ret.state[0][0] = "";
		}

		// Handle e.p. captures...

		if (pawn_flag && capture_flag && ret.state[x2][y2] === "") {
			ret.state[x2][y1] = "";
		}

		// Set e.p. square...

		ret.enpassant = Point("??");

		if (pawn_flag && y1 === 6 && y2 === 4) {
			ret.enpassant = Point(x1, 5);
		}

		if (pawn_flag && y1 === 1 && y2 === 3) {
			ret.enpassant = Point(x1, 2);
		}

		// Actually make the move...

		ret.state[x2][y2] = ret.state[x1][y1];
		ret.state[x1][y1] = "";

		// Handle promotions...

		if (y2 === 0 && pawn_flag) {
			ret.state[x2][y2] = promotion.toUpperCase();
		}

		if (y2 === 7 && pawn_flag) {
			ret.state[x2][y2] = promotion.toLowerCase();
		}

		// Set active player...

		ret.active = white_flag ? "b" : "w";

		return ret;
	};

	p.illegal = (s) => {

		// Returns "" if the move is legal, otherwise returns the reason it isn't.

		let [x1, y1] = XY(s.slice(0, 2));
		let [x2, y2] = XY(s.slice(2, 4));

		if (x1 < 0 || y1 < 0 || x1 > 7 || y1 > 7 || x2 < 0 || y2 < 0 || x2 > 7 || y2 > 7) {
			return "off board";
		}

		if (p.active === "w" && p.is_white(Point(x1, y1)) === false) {
			return "wrong colour source";
		}

		if (p.active === "b" && p.is_black(Point(x1, y1)) === false) {
			return "wrong colour source";
		}

		if (p.same_colour(Point(x1, y1), Point(x2, y2))) {
			return "source and destination have same colour";
		}

		if ("Nn".includes(p.state[x1][y1])) {
			if (Math.abs(x2 - x1) + Math.abs(y2 - y1) !== 3) {
				return "illegal knight movement";
			}
			if (Math.abs(x2 - x1) === 0 || Math.abs(y2 - y1) === 0) {
				return "illegal knight movement";
			}
		}

		if ("Bb".includes(p.state[x1][y1])) {
			if (Math.abs(x2 - x1) !== Math.abs(y2 - y1)) {
				return "illegal bishop movement";
			}
		}

		if ("Rr".includes(p.state[x1][y1])) {
			if (Math.abs(x2 - x1) > 0 && Math.abs(y2 - y1) > 0) {
				return "illegal rook movement";
			}
		}

		if ("Qq".includes(p.state[x1][y1])) {
			if (Math.abs(x2 - x1) !== Math.abs(y2 - y1)) {
				if (Math.abs(x2 - x1) > 0 && Math.abs(y2 - y1) > 0) {
					return "illegal queen movement";
				}
			}
		}

		// Pawns...

		if ("Pp".includes(p.state[x1][y1])) {

			if (Math.abs(x2 - x1) === 0) {
				if (p.state[x2][y2] !== "") {
					return "pawn cannot capture forwards";
				}
			}

			if (Math.abs(x2 - x1) > 1) {
				return "pawn cannot move that far sideways";
			}

			if (Math.abs(x2 - x1) === 1) {

				if (p.state[x2][y2] === "") {
					if (p.enpassant !== Point(x2, y2)) {
						return "pawn cannot capture thin air";
					}
				}

				if (Math.abs(y2 - y1) !== 1) {
					return "pawn must move 1 forward when capturing";
				}
			}

			if (p.state[x1][y1] === "P") {
				if (y1 !== 6) {
					if (y2 - y1 !== -1) {
						return "pawn must move forwards 1";
					}
				} else {
					if (y2 - y1 !== -1 && y2 - y1 !== -2) {
						return "pawn must move forwards 1 or 2";
					}
				}
			}

			if (p.state[x1][y1] === "p") {
				if (y1 !== 1) {
					if (y2 - y1 !== 1) {
						return "pawn must move forwards 1";
					}
				} else {
					if (y2 - y1 !== 1 && y2 - y1 !== 2) {
						return "pawn must move forwards 1 or 2";
					}
				}
			}
		}

		// Kings...

		if ("Kk".includes(p.state[x1][y1])) {

			if (Math.abs(x2 - x1) > 1 || Math.abs(y2 - y1) > 1) {

				// This should be an attempt to castle...

				if (s !== "e1g1" && s !== "e1c1" && s !== "e8g8" && s !== "e8c8") {
					return "illegal king movement";
				}

				// So it is an attempt to castle. But is it allowed?

				if (s === "e1g1" && p.castling.includes("K") === false) {
					return "lost the right to castle that way";
				}

				if (s === "e1c1" && p.castling.includes("Q") === false) {
					return "lost the right to castle that way";
				}

				if (s === "e8g8" && p.castling.includes("k") === false) {
					return "lost the right to castle that way";
				}

				if (s === "e8c8" && p.castling.includes("q") === false) {
					return "lost the right to castle that way";
				}

				// For queenside castling, check that the rook isn't blocked by a piece on the B file...

				if (x2 === 2 && p.piece(Point(1, y2)) !== "") {
					return "queenside castling blocked on B-file";
				}

				// Check that king source square and the pass-through square aren't under attack.
				// Destination will be handled by the general in-check test later.
				
				if (p.attacked(Point(x1, y1), p.active)) {
					return "cannot castle under check";
				}

				if (p.attacked(Point((x1 + x2) / 2, y1), p.active)) {
					return "cannot castle through check";
				}
			}
		}

		// Check for blockers...
		// K and k are included to spot castling blockers.

		if ("KQRBPkqrbp".includes(p.state[x1][y1])) {
			if (p.los(x1, y1, x2, y2) === false) {
				return "movement blocked";
			}
		}

		// Check for check...

		let tmp = p.move(s);

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				if (tmp.state[x][y] === "K" && p.active === "w") {
					if (tmp.attacked(Point(x, y), p.active)) {
						return "king in check";
					}
				}
				if (tmp.state[x][y] === "k" && p.active === "b") {
					if (tmp.attacked(Point(x, y), p.active)) {
						return "king in check";
					}
				}
			}
		}

		return "";
	};

	p.los = (x1, y1, x2, y2) => {		// Returns false if there is no "line of sight" between the 2 points.

		// Check the line is straight....

		if (Math.abs(x2 - x1) > 0 && Math.abs(y2 - y1) > 0) {
			if (Math.abs(x2 - x1) !== Math.abs(y2 - y1)) {
				return false;
			}
		}

		let step_x;
		let step_y;

		if (x1 === x2) step_x = 0;
		if (x1 < x2) step_x = 1;
		if (x1 > x2) step_x = -1;

		if (y1 === y2) step_y = 0;
		if (y1 < y2) step_y = 1;
		if (y1 > y2) step_y = -1;

		let x = x1;
		let y = y1;

		while (true) {

			x += step_x;
			y += step_y;

			if (x === x2 && y === y2) {
				return true;
			}

			if (p.state[x][y] !== "") {
				return false;
			}
		}
	};

	p.attacked = (target, my_colour) => {

		if (target === null_point) {
			return false;
		}

		// Attacks along the lines (excludes pawns)...

		for (let step_x = -1; step_x <= 1; step_x++) {

			for (let step_y = -1; step_y <= 1; step_y++) {

				if (step_x === 0 && step_y === 0) continue;

				if (p.line_attack(target, step_x, step_y, my_colour)) {
					return true;
				}
			}
		}

		// Knights... this must be the stupidest way possible...

		for (let dx = -2; dx <= 2; dx++) {
			for (let dy = -2; dy <= 2; dy++) {

				if (Math.abs(dx) + Math.abs(dy) !== 3) continue;

				let x = target.x + dx;
				let y = target.y + dy;

				if (x < 0 || x > 7 || y < 0 || y > 7) continue;

				if (p.state[x][y] === "") continue;		// Necessary, to prevent "Nn".includes() having false positives
				if ("Nn".includes(p.state[x][y])) {
					if (p.colour(Point(x, y)) === my_colour) continue;
					return true;
				}
			}
		}

		return false;
	};

	p.line_attack = (target, step_x, step_y, my_colour) => {

		// Is the target square under attack via the line specified by step_x and step_y (which are both -1, 0, or 1) ?

		let x = target.x;
		let y = target.y;

		let ranged_attackers = "QqRr";					// Ranged attackers that can go in a cardinal direction.
		if (step_x !== 0 && step_y !== 0) {
			ranged_attackers = "QqBb";					// Ranged attackers that can go in a diagonal direction.
		}

		let iteration = 0;

		while (true) {

			iteration++;

			x += step_x;
			y += step_y;

			if (x < 0 || x > 7 || y < 0 || y > 7) {
				return false;
			}

			if (p.state[x][y] === "") {
				continue;
			}

			// So there's something here. Must return now.

			if (p.colour(Point(x, y)) === my_colour) {
				return false;
			}

			// We now know the piece is hostile. This allows us to mostly not care
			// about distinctions between "Q" and "q", "R" and "r", etc.

			// Is it one of the ranged attacker types?

			if (ranged_attackers.includes(p.state[x][y])) {
				return true;
			}

			// Pawns and kings are special cases (attacking iff it's the first iteration)

			if (iteration === 1) {

				if ("Kk".includes(p.state[x][y])) {
					return true;
				}

				if (Math.abs(step_x) === 1) {

					if (p.state[x][y] === "p" && step_y === -1) {		// Black pawn in attacking position
						return true;
					}

					if (p.state[x][y] === "P" && step_y === 1) {		// White pawn in attacking position
						return true;
					}
				}
			}

			return false;
		}
	};

	p.find = (piece, startx, starty, endx, endy) => {

		// Find all pieces of the specified type (colour-specific).
		// Returned as a list of points.

		if (startx === undefined || starty === undefined || endx === undefined || endy === undefined) {
			startx = 0;
			starty = 0;
			endx = 7;
			endy = 7;
		}

		let ret = [];

		for (let x = startx; x <= endx; x++) {
			for (let y = starty; y <= endy; y++) {
				if (p.state[x][y] === piece) {
					ret.push(Point(x, y));
				}
			}
		}

		return ret;
	};

	p.parse_pgn = (s) => {		// Returns a move and an error message.

		// Delete things we don't need...

		s = s.replace("x", "");
		s = s.replace("+", "");
		s = s.replace("#", "");

		// Fix castling with zeroes...

		s = s.replace("0-0", "O-O");
		s = s.replace("0-0-0", "O-O-O");

		// Castling...	FIXME: should legality check

		if (s.toUpperCase() === "O-O") {
			if (p.active === "w") {
				return ["e1g1", ""];
			} else {
				return ["e8g8", ""];
			}
		}

		if (s.toUpperCase() === "O-O-O") {
			if (p.active === "w") {
				return ["e1c1", ""];
			} else {
				return ["e8c8", ""];
			}
		}

		// Just in case, delete any "-" characters (after handling castling, of course)...

		s = s.replace("-", "");

		// Save promotion string, if any, then delete it from s...

		let promotion = "";

		if (s[s.length - 2] === "=") {
			promotion = s[s.length - 1].toLowerCase();
			s = s.slice(0, s.length - 2);
		}

		let piece;

		// If the piece isn't specified (with an uppercase letter) then it's a pawn move.
		// Let's add P to the start of the string to keep the string format consistent.

		if ("KQRBNP".includes(s[0]) === false) {
			s = "P" + s;
		}

		piece = s[0];

		if (p.active === "b") {
			piece = piece.toLowerCase();
		}

		// The last 2 characters specify the target point...

		let dest_string = s.slice(s.length - 2, s.length);

		// Any characters between the piece and target should be disambiguators...

		let disambig = s.slice(1, s.length - 2);

		let startx = 0;
		let endx = 7;

		let starty = 0;
		let endy = 7;

		for (let c of Array.from(disambig)) {
			if (c >= "a" && c <= "h") {
				startx = c.charCodeAt(0) - 97;
				endx = startx;
			}
			if (c >= "1" && c <= "8") {
				starty = 7 - (c.charCodeAt(0) - 49);
				endy = starty;
			}
		}

		// If it's a pawn and hasn't been disambiguated then it is moving forwards...

		if (piece === "P" || piece === "p") {
			if (disambig.length === 0) {
				startx = Point(dest_string).x;
				endx = Point(dest_string).x;
			}
		}

		let sources = p.find(piece, startx, starty, endx, endy);

		if (sources.length === 0) {
			return ["", "piece not found"];
		}

		let possible_moves = [];

		for (let source of sources) {
			possible_moves.push(source.s + dest_string);
		}

		let valid_moves = [];

		for (let move of possible_moves) {
			if (p.illegal(move) === "") {
				valid_moves.push(move);
			}
		}

		if (valid_moves.length === 1) {
			return [valid_moves[0] + promotion, ""];
		}

		if (valid_moves.length === 0) {
			return ["", "piece found but move illegal"];
		}

		if (valid_moves.length === 2) {
			return ["", "ambiguous move"];
		}
	};

	p.piece = (point) => {
		if (point === null_point) return "";
		return p.state[point.x][point.y];
	};

	p.is_white = (point) => {
		if (p.piece(point) === "") {
			return false;
		}
		return "KQRBNP".includes(p.piece(point));
	};

	p.is_black = (point) => {
		if (p.piece(point) === "") {
			return false;
		}
		return "kqrbnp".includes(p.piece(point));
	};

	p.is_empty = (point) => {
		return p.piece(point) === "";
	};

	p.colour = (point) => {
		if (p.is_white(point)) return "w";
		if (p.is_black(point)) return "b";
		return "";
	};

	p.same_colour = (point1, point2) => {
		return p.colour(point1) === p.colour(point2);
	};

	p.nice_string = (s) => {

		// Given some raw UCI move string, return a nice human-readable string.
		// FIXME: disambiguate
		// FIXME: indicate checks

		let [x1, y1] = XY(s.slice(0, 2));
		let [x2, y2] = XY(s.slice(2, 4));

		let piece = p.piece(Point(x1, y1));

		if ("KkQqRrBbNn".includes(piece)) {

			if ("Kk".includes(piece)) {
				if (s === "e1g1" || s === "e8g8") {
					return "O&#8209;O";				// Non breaking hyphen character used.
				}
				if (s === "e1c1" || s === "e8c8") {
					return "O&#8209;O&#8209;O";		// Non breaking hyphen character used.
				}
			}

			if (p.piece(Point(x2, y2)) === "") {
				return piece.toUpperCase() + s.slice(2, 4);
			} else {
				return piece.toUpperCase() + "x" + s.slice(2, 4);
			}
		}

		// So it's a pawn...

		let ret;

		if (x1 === x2) {
			ret = s.slice(2, 4);
		} else {
			ret = s[0] + "x" + s.slice(2, 4);
		}

		if (s.length > 4) {
			ret += "=";
			ret += s[4].toUpperCase();
		}

		return ret;
	};

	p.fen = () => {

		let s = "";

		for (let y = 0; y < 8; y++) {

			let x = 0;
			let blanks = 0;

			while (true) {

				if (p.state[x][y] === "") {
					blanks++;
				} else {
					if (blanks > 0) {
						s += blanks.toString();
						blanks = 0;
					}
					s += p.state[x][y];
				}

				x++;

				if (x >= 8) {
					if (blanks > 0) {
						s += blanks.toString();
					}
					if (y < 7) {
						s += "/";
					}
					break;
				}
			}
		}

		let ep_string = p.enpassant === null_point ? "-" : p.enpassant.s;
		let castling_string = p.castling === "" ? "-" : p.castling;

		return s + ` ${p.active} ${castling_string} ${ep_string} ${p.halfmove} ${p.fullmove}`;
	};

	p.simple_string = () => {

		// Returns a simple representation of the board, which is convenient to
		// use for the mouseover functions.

		let chars = new Array(64);
		for (let y = 0; y < 8; y++) {
			for (let x = 0; x < 8; x++) {
				let c = p.state[x][y];
				chars[y * 8 + x] = c !== "" ? c : ".";
			}
		}
		return chars.join("");
	};

	p.history = () => {
		let list = [];
		let node = p;
		while (node.parent !== null) {		// no parent implies no lastmove
			list.push(node.lastmove);
			node = node.parent;
		}
		list.reverse();
		return list;
	};

	p.position_list = () => {
		let list = [];
		let node = p;
		while (node !== null) {
			list.push(node);
			node = node.parent;
		}
		list.reverse();
		return list;
	};

	p.initial_fen = () => {

		// When sending the engine the position, the UCI specs involve sending the initial FEN
		// and then a list of moves. This method finds the initial FEN.

		let node = p;

		while (node.parent) {
			node = node.parent;
		}

		return node.fen();
	};

	return p;
}

// ------------------------------------------------------------------------------------------------

function LoadFEN(fen) {

	let ret = NewPosition();

	fen = fen.replace("\t", " ");
	fen = fen.replace("\n", " ");
	fen = fen.replace("\r", " ");

	let tokens = fen.split(" ").filter(s => s !== "");

	if (tokens.length !== 6) {
		throw "Invalid FEN - token count";
	}

	let rows = tokens[0].split("/");

	if (rows.length !== 8) {
		throw "Invalid FEN - board row count";
	}

	for (let y = 0; y < 8; y++) {

		let chars = Array.from(rows[y]);

		let x = 0;

		for (let c of chars) {

			if (x > 7) {
				throw "Invalid FEN - row length";
			}

			if ("12345678".includes(c)) {
				x += parseInt(c, 10);
				continue;
			}

			if ("KkQqRrBbNnPp".includes(c)) {
				ret.state[x][y] = c;
				x++;
				continue;
			}

			throw "Invalid FEN - unknown piece";
		}

		if (x !== 8) {
			throw "Invalid FEN - row length";
		}
	}

	tokens[1] = tokens[1].toLowerCase();
	if (tokens[1] !== "w" && tokens[1] !== "b") {
		throw "Invalid FEN - active player";
	}
	ret.active = tokens[1];

	ret.castling = "";
	if (tokens[2].includes("K")) ret.castling += "K";
	if (tokens[2].includes("Q")) ret.castling += "Q";
	if (tokens[2].includes("k")) ret.castling += "k";
	if (tokens[2].includes("q")) ret.castling += "q";

	tokens[3] = tokens[3].toLowerCase();
	ret.enpassant = Point(tokens[3]);
	
	ret.halfmove = parseInt(tokens[4], 10);
	if (Number.isNaN(ret.halfmove)) {
		throw "Invalid FEN - halfmoves";
	}

	ret.fullmove = parseInt(tokens[5], 10);
	if (Number.isNaN(ret.fullmove)) {
		throw "Invalid FEN - fullmoves";
	}

	let white_kings = 0;
	let black_kings = 0;

	for (let x = 0; x < 8; x++) {
		for (let y = 0; y < 8; y++) {
			if (ret.state[x][y] === "K") white_kings++;
			if (ret.state[x][y] === "k") black_kings++;
		}
	}

	if (white_kings !== 1 || black_kings !== 1) {
		throw "Invalid FEN - number of kings";
	}

	return ret;
}

// ------------------------------------------------------------------------------------------------

function make_renderer() {

	let renderer = Object.create(null);

	renderer.pos = LoadFEN("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
	renderer.info = Object.create(null);			// Map of move (e.g. "e2e4") --> info object, see NewInfo().
	renderer.squares = [];							// Info about clickable squares.
	renderer.active_square = null;					// Square clicked by user.
	renderer.running = false;						// Whether to send "go" to the engine after move, undo, etc.
	renderer.ever_received_info = false;			// When false, we write stderr log instead of move info.
	renderer.stderr_log = "";						// All output received from the engine's stderr.
	renderer.infobox_string = "";					// Just to help not redraw the infobox when not needed.

	fenbox.value = renderer.pos.fen();

	renderer.square_size = () => {
		return config.board_size / 8;
	};

	renderer.changed = () => {
		renderer.active_square = null;
		renderer.info = Object.create(null);
		fenbox.value = renderer.pos.fen();

		let poslist = renderer.pos.position_list();
		let elements = [];
		for (let n = 0; n < poslist.length - 1; n++) {
			if (poslist[n].active === "w") {
				elements.push(`${poslist[n].fullmove}.`);
			} else if (n === 0) {
				elements.push(`${poslist[n].fullmove}...`);
			}
			let nice_string = poslist[n].nice_string(poslist[n + 1].lastmove);
			elements.push(nice_string);
		}
		mainline.innerHTML = elements.join(" ");
	}

	renderer.load_fen = (s) => {

		if (renderer.pos.fen() === s) {
			return;
		}

		try {
			renderer.pos = LoadFEN(s);
		} catch (err) {
			alert(err);
			return;
		}

		renderer.changed();

		if (renderer.running) {
			renderer.go(true);
		} else {
			send("ucinewgame");
		}

		renderer.draw();
	};

	renderer.move = (s) => {						// Does not call draw() but the caller should

		renderer.pos = renderer.pos.move(s);
		renderer.changed();

		if (renderer.running) {
			renderer.go();
		}
	};

	renderer.undo = () => {

		if (renderer.pos.parent) {
			renderer.pos = renderer.pos.parent;
			renderer.changed();
		}

		if (renderer.running) {
			renderer.go();
		}

		renderer.draw();
	};

	renderer.new = () => {
		renderer.load_fen("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1");
	};

	renderer.play_best = () => {
		let info_list = renderer.info_sorted();
		if (info_list.length > 0) {
			renderer.move(info_list[0].move);
		}
		renderer.draw();
	};

	renderer.go = (new_game_flag) => {

		renderer.running = true;

		let setup;

		let initial_fen = renderer.pos.initial_fen();
		if (initial_fen !== "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1") {
			setup = `fen ${initial_fen}`;
		} else {
			setup = "startpos";
		}

		send("stop");
		if (new_game_flag) {
			send("ucinewgame");
		}

		send(`position ${setup} moves ${renderer.pos.history().join(" ")}`);
		sync();																	// See comment on how sync() works
		send("go");
	};

	renderer.halt = () => {
		send("stop");
		renderer.running = false;
	};

	renderer.receive = (s) => {

		if (s.startsWith("info")) {
			renderer.ever_received_info = true;
		}

		if (s.startsWith("info depth")) {

			// info depth 13 seldepth 48 time 5603 nodes 67686 score cp 40 hashfull 204 nps 12080 tbhits 0 multipv 2
			// pv d2d4 g8f6 c2c4 e7e6 g2g3 f8b4 c1d2 b4e7 g1f3 e8g8 d1c2 a7a6 f1g2 b7b5 e1g1 c8b7 f1c1 b7e4 c2d1 b5c4 c1c4 a6a5 d2e1 h7h6 c4c1 d7d6

			let move = InfoVal(s, "pv");

			let move_info;

			if (renderer.info[move]) {
				move_info = renderer.info[move];
			} else {
				move_info = NewInfo();
				renderer.info[move] = move_info;
			}

			move_info.move = move;
			move_info.cp = parseInt(InfoVal(s, "cp"), 10);				// Score in centipawns
			move_info.multipv = parseInt(InfoVal(s, "multipv"), 10);	// Leela's ranking of the move, starting at 1
			move_info.pv = InfoPV(s);

		} else if (s.startsWith("info string")) {

			// info string d2d4  (293 ) N:   12845 (+121) (P: 20.10%) (Q:  0.09001) (D:  0.000) (U: 0.02410) (Q+U:  0.11411) (V:  0.1006)

			let move = InfoVal(s, "string");

			let move_info;

			if (renderer.info[move]) {
				move_info = renderer.info[move];
			} else {
				move_info = NewInfo();
				renderer.info[move] = move_info;
			}

			move_info.move = move;
			move_info.n = parseInt(InfoVal(s, "N:"), 10);

			move_info.p = InfoVal(s, "(P:");
			if (move_info.p.endsWith(")")) {
				move_info.p = move_info.p.slice(0, move_info.p.length - 1);
			};

		} else if (s.startsWith("error")) {
			renderer.err_receive(s);
		}

	};

	renderer.err_receive = (s) => {
		renderer.stderr_log += s;
		renderer.stderr_log += "<br>";
	};

	renderer.click = (event) => {

		let point = null;

		for (let n = 0; n < renderer.squares.length; n++) {
			let foo = renderer.squares[n];
			if (foo.x1 < event.offsetX && foo.y1 < event.offsetY && foo.x2 > event.offsetX && foo.y2 > event.offsetY) {
				point = foo.point;
				break;
			}
		}

		if (point === null) {
			return;
		}

		if (renderer.active_square) {

			let move_string = renderer.active_square.s + point.s;		// e.g. "e2e4"

			let illegal_reason = renderer.pos.illegal(move_string);	

			if (illegal_reason === "") {			
				renderer.move(move_string);
			} else {
				console.log(illegal_reason);
			}

			renderer.active_square = null;

		} else {

			if (renderer.pos.active === "w" && renderer.pos.is_white(point)) {
				renderer.active_square = point;
			}
			if (renderer.pos.active === "b" && renderer.pos.is_black(point)) {
				renderer.active_square = point;
			}
		}

		renderer.draw();
	};

	renderer.info_sorted = () => {

		let info_list = [];

		for (let key of Object.keys(renderer.info)) {
			info_list.push(renderer.info[key]);
		}

		info_list.sort((a, b) => {
			if (a.n < b.n) {
				return 1;
			}
			if (a.n > b.n) {
				return -1;
			}
			if (a.cp < b.cp) {
				return 1;
			}
			if (a.cp > b.cp) {
				return -1;
			}
			return 0;
		});

		return info_list;
	};

	renderer.draw_info = () => {

		if (renderer.ever_received_info === false) {
			if (infobox.innerHTML !== renderer.stderr_log) {	// Only update when needed, so user can select and copy.
				infobox.innerHTML = renderer.stderr_log;
			}
			return;
		}

		let info_list = renderer.info_sorted();

		let s = "";

		if (renderer.running === false) {
			s += "&lt;halted&gt;<br><br>";
		}

		for (let i = 0; i < info_list.length && i < config.max_info_lines; i++) {

			let cp_string = info_list[i].cp.toString();
			if (cp_string.startsWith("-") === false) {
				cp_string = "+" + cp_string;
			}
			let n_string = info_list[i].n.toString();

			let pv_string = "";
			let tmp_board = renderer.pos.copy();

			for (let move of info_list[i].pv) {

				if (tmp_board.active === "w") {
					pv_string += `<span class="white">`;
				} else {
					pv_string += `<span class="black">`;
				}
				pv_string += tmp_board.nice_string(move);
				pv_string += "</span> ";

				if (config.show_pv === false) {
					break;
				}

				tmp_board = tmp_board.move(move);
			}

			s += pv_string.trim();

			if (config.show_n || config.show_cp || config.show_p) {
				
				let tech_elements = []

				if (config.show_n) {
					tech_elements.push(`N: ${n_string}`);
				}

				if (config.show_cp) {
					tech_elements.push(`cp: ${cp_string}`);
				}

				if (config.show_p) {
					tech_elements.push(`P: ${info_list[i].p}`);
				}

				s += ` <span class="tech">(${tech_elements.join(" ")})</span>`;
			}

			s += "<br><br>";
		}

		if (renderer.infobox_string !== s) {		// Only update when needed, so user can select and copy. A direct
													// comparison of s with innerHTML seems to fail (something must get changed).
			renderer.infobox_string = s;
			infobox.innerHTML = s;
		}

		// ------------------------------------------

		if (info_list.length === 0) {
			return;
		}

		let best_nodes = info_list[0].n;

		context.lineWidth = 8;
		
		for (let i = info_list.length - 1; i >= 0; i--) {

			if (info_list[i].n > best_nodes * config.node_display_threshold) {

				let loss = info_list[0].cp - info_list[i].cp;

				if (i === 0) {
					context.strokeStyle = "#66aaaa";
					context.fillStyle = "#66aaaa";
				} else if (loss < config.bad_cp_threshold) {
					context.strokeStyle = "#66aa66";
					context.fillStyle = "#66aa66";
				} else {
					context.strokeStyle = "#cccc66";
					context.fillStyle = "#cccc66";
				}

				let [x1, y1] = XY(info_list[i].move.slice(0, 2));
				let [x2, y2] = XY(info_list[i].move.slice(2, 4));

				let rss = renderer.square_size();

				let cx1 = x1 * rss + rss / 2;
				let cy1 = y1 * rss + rss / 2;
				let cx2 = x2 * rss + rss / 2;
				let cy2 = y2 * rss + rss / 2;

        		context.beginPath();
        		context.moveTo(cx1, cy1);
        		context.lineTo(cx2, cy2);
				context.stroke();
				
				context.beginPath();
				context.arc(cx2, cy2, 12, 0, 2 * Math.PI);
				context.fill();
			}
		}
	};

	renderer.draw = () => {

		let rss = renderer.square_size();
		
		renderer.squares = [];

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				if (x % 2 !== y % 2) {
					context.fillStyle = dark;
				} else {
					context.fillStyle = light;
				}

				let x1 = x * rss;
				let y1 = y * rss;
				let x2 = x1 + rss;
				let y2 = y1 + rss;

				if (renderer.active_square === Point(x, y)) {
					context.fillStyle = act;
				}

				context.fillRect(x1, y1, rss, rss);
				renderer.squares.push({x1, y1, x2, y2, point: Point(x, y)});
			}
		}

		// Draw enemy pieces...

		let opponent_colour = renderer.pos.active === "w" ? "b" : "w";

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				if (renderer.pos.colour(Point(x, y)) === opponent_colour) {
					let piece = renderer.pos.state[x][y];
					let cx = x * rss;
					let cy = y * rss;
					context.drawImage(images[piece], cx, cy, rss, rss);
				}
			}
		}

		renderer.draw_info();		// Do this here so the arrows are below the friendly pieces

		// Draw friendly pieces...

		for (let x = 0; x < 8; x++) {
			for (let y = 0; y < 8; y++) {
				if (renderer.pos.colour(Point(x, y)) === renderer.pos.active) {
					let piece = renderer.pos.state[x][y];
					let cx = x * rss;
					let cy = y * rss;
					context.drawImage(images[piece], cx, cy, rss, rss);
				}
			}
		}
	};

	renderer.draw_loop = () => {
		renderer.draw();
		setTimeout(renderer.draw_loop, 250);
	};

	return renderer;
}

// ------------------------------------------------------------------------------------------------

let renderer = make_renderer();

ipcRenderer.on("undo", () => {
	renderer.undo();
});

ipcRenderer.on("go", () => {
	renderer.go();
});

ipcRenderer.on("halt", () => {
	renderer.halt();
});

ipcRenderer.on("play_best", () => {
	renderer.play_best();
});

ipcRenderer.on("new", () => {
	renderer.new();
});

canvas.addEventListener("mousedown", (event) => {
	renderer.click(event);
});

// Setup return key on FEN box...
document.getElementById("fenbox").onkeydown = function(event) {
	if (event.keyCode === 13) {
		renderer.load_fen(document.getElementById("fenbox").value);
	}
};

function draw_after_images_load() {
	if (loads === 12) {
		renderer.draw_loop();
	} else {
		setTimeout(draw_after_images_load, 25);
	}
}

draw_after_images_load();
