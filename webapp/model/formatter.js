sap.ui.define([
	"sap/ui/core/library"
] , function (coreLibrary) {
	"use strict";

	// shortcut for sap.ui.core.ValueState
	var ValueState = coreLibrary.ValueState;

	return {

		/**
		 * Rounds the number unit value to 2 digits
		 * @public
		 * @param {string} sValue the number string to be rounded
		 * @returns {string} sValue with 2 digits rounded
		 */
		numberUnit : function (sValue) {
			if (!sValue) {
				return "";
			}
			return parseFloat(sValue).toFixed(2);
		},

		/**
		 * Defines a value state based on the stock level
		 *
		 * @public
		 * @param {number} iValue the stock level of a product
		 * @returns {string} sValue the state for the stock level
		 */
		quantityState: function(iValue) {
			if (iValue === 0) {
				return ValueState.Error;
			} else if (iValue <= 10) {
				return ValueState.Warning;
			} else {
				return ValueState.Success;
			}
		},

		/**
		 * Estado de tolerancia (según nueva codificación del backend)
		 * -  1  -> Success (🟢)  Sin diferencia
		 * -  0  -> Warning (🟡)  Dentro de tolerancia
		 * - -1  -> Error (🔴)    Fuera de tolerancia
		 */
		estadoTolState: function (v) {
			if (v == null || v === "") {
				// fallback: si no viene, asumimos "sin diferencia" para no bloquear UI
				return ValueState.Success;
			}
			var n = Number(v);
			if (isNaN(n)) {
				return ValueState.None;
			}
			if (n === 1) {
				return ValueState.Success;
			}
			if (n === 0) {
				return ValueState.Warning;
			}
			if (n === -1) {
				return ValueState.Error;
			}
			return ValueState.None;
		},

		estadoTolText: function (v) {
			if (v == null || v === "") {
				return "Sin diferencia";
			}
			var n = Number(v);
			if (isNaN(n)) {
				return "";
			}
			if (n === 1) {
				return "Sin diferencia";
			}
			if (n === 0) {
				return "Dentro de tolerancia";
			}
			if (n === -1) {
				return "Fuera de tolerancia";
			}
			return "";
		}

	};

});