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
		 * Estado de tolerancia para icono/estado
		 * - 0 o vacío  -> Success (🟢)
		 * - <= 5       -> Warning (🟡)
		 * - > 5        -> Error (🔴)
		 */
		estadoTolState: function (v) {
			if (v == null || v === "") {
				return ValueState.Success;
			}
			var n = Number(v);
			if (isNaN(n) || n === 0) {
				return ValueState.Success;
			}
			n = Math.abs(n);
			return (n <= 5) ? ValueState.Warning : ValueState.Error;
		},

		estadoTolText: function (v) {
			if (v == null || v === "") {
				return "Sin diferencia";
			}
			var n = Number(v);
			if (isNaN(n) || n === 0) {
				return "Sin diferencia";
			}
			n = Math.abs(n);
			return (n <= 5) ? "Dentro de tolerancia" : "Fuera de tolerancia";
		}

	};

});