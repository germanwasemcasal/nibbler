"use strict";

function background(light, dark, square_size) {

	let c = document.createElement("canvas");
	c.width = square_size * 8;
	c.height = square_size * 8;
	let ctx = c.getContext("2d");
var letras = ["a","b","c","d","e","f","g","h"];
	for (let x = 0; x < 8; x++) {
		
		for (let y = 0; y < 8; y++) {
			ctx.fillStyle = (x + y) % 2 === 0 ? light : dark;

			ctx.fillRect(x * square_size, y * square_size, square_size, square_size);
			ctx.font = 'bold 14px Arial';
			ctx.fillStyle = 'black';
			ctx.fillText(letras[x] +"-"+(9-y), x * square_size, y * square_size);
		
		}
	}

	// I guess the canvas c gets garbage-collected? https://stackoverflow.com/questions/15320853

	return `url("${c.toDataURL("image/png")}")`;
}

module.exports = background;
