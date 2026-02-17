sap.ui.define([
	"./BaseController",
	"sap/ui/model/json/JSONModel",
	"com/nttdata/cuentas/model/formatter",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/core/Messaging",
	"sap/ui/core/message/ControlMessageProcessor",
	"sap/ui/core/message/Message",
	"sap/ui/core/message/MessageType",
	"sap/m/MessagePopover",
	"sap/m/MessageItem",
], function (BaseController, JSONModel, formatter, Filter, FilterOperator, Messaging, ControlMessageProcessor, Message, MessageType, MessagePopover, MessageItem) {
	"use strict";

	return BaseController.extend("com.nttdata.cuentas.controller.Worklist", {
		formatter: formatter,
		onInit: function () {
			var oViewModel,
				iOriginalBusyDelay,
				oTable = this.byId("table"),
				that = this;

			iOriginalBusyDelay = oTable.getBusyIndicatorDelay();
			this._oTable = oTable;
			this._aTableSearchState = [];

			oViewModel = new JSONModel({
				worklistTableTitle: this.getResourceBundle().getText("worklistTableTitle"),
				shareOnJamTitle: this.getResourceBundle().getText("worklistTitle"),
				shareSendEmailSubject: this.getResourceBundle().getText("shareSendEmailWorklistSubject"),
				shareSendEmailMessage: this.getResourceBundle().getText("shareSendEmailWorklistMessage", [location.href]),
				tableNoDataText: this.getResourceBundle().getText("tableNoDataText"),
				tableBusyDelay: 0,
				colStatusFacturacionVisible: false,
				colFacturaVisible: false,
				colStatusEnvioSunatVisible: false,
				colReferenciaVisible: false,
				colStatusMIROVisible: false,
				colDocMIROVisible: false,
				centroSumOptions: [],
				centroRecepOptions: [],
				materialOptions: [],
				selectedCentroSum: "",
				selectedCentroRecep: "",
				selectedMaterial: "",
				entregaRange: null,
				tableSelectionMode: "MultiSelect",
				processBtnVisible: true
			});
			this.setModel(oViewModel, "worklistView");

			// Load mock data for Pedidos
			var oPedidosModel = new JSONModel();
			oPedidosModel.loadData("/localService/mockdata/PedidosCamel.json");
			this.getView().setModel(oPedidosModel, "pedidos");


			// Dynamically generate filter options from PedidosCamel data for consistency
			oPedidosModel.attachRequestCompleted(function () {
				var aPedidos = oPedidosModel.getData();
				if (Array.isArray(aPedidos)) {
					// Efficiently flag mismatches
					aPedidos.forEach(function (item) {
						item._mismatch = (item.cantSal !== item.cantEnt);
					});
					// Generate filter options
					var centroSumSet = new Set(), centroRecepSet = new Set(), materialSet = new Set();
					aPedidos.forEach(function (item) {
						if (item.centroSum) centroSumSet.add(item.centroSum);
						if (item.centroRecep) centroRecepSet.add(item.centroRecep);
						if (item.material) materialSet.add(item.material);
					});
					var centroSumOptions = [{ key: '', text: 'Todos' }];
					centroSumSet.forEach(function (val) { centroSumOptions.push({ key: val, text: val }); });
					var centroRecepOptions = [{ key: '', text: 'Todos' }];
					centroRecepSet.forEach(function (val) { centroRecepOptions.push({ key: val, text: val }); });
					var materialOptions = [{ key: '', text: 'Todos' }];
					materialSet.forEach(function (val) { materialOptions.push({ key: val, text: val }); });
					oViewModel.setProperty("/centroSumOptions", centroSumOptions);
					oViewModel.setProperty("/centroRecepOptions", centroRecepOptions);
					oViewModel.setProperty("/materialOptions", materialOptions);
				}
			});

			oTable.attachEventOnce("updateFinished", function () {
				oViewModel.setProperty("/tableBusyDelay", iOriginalBusyDelay);
			});

			let oMessageProcessor = new ControlMessageProcessor();

			Messaging.registerMessageProcessor(oMessageProcessor);

			Messaging.addMessages([
				new Message({
					message: "Los registros fueron enviados correctamente para su procesamiento.",
					type: MessageType.Success,
					processor: oMessageProcessor
				}),
				new Message({
					message: "Existen registros con diferencias entre Cant. Salida y Cant. Entrega que no serán procesados.",
					type: MessageType.Warning,
					processor: oMessageProcessor
				}),
				new Message({
					message: "Error al enviar los registros para su procesamiento. Por favor, intente nuevamente.",
					type: MessageType.Error,
					processor: oMessageProcessor
				}),
				new Message({
					message: "No se han seleccionado registros para procesar.",
					type: MessageType.Information,
					processor: oMessageProcessor
				})]
			);
		}, // END onInit

		/**
		 * Event handler for FilterBar search event
		 * @public
		 */
		onFilterBarSearch: function (oEvent) {
			var oView = this.getView();
			var oViewModel = this.getModel("worklistView");
			var aFilters = [];
			var sCentroSum = oViewModel.getProperty("/selectedCentroSum");
			var sCentroRecep = oViewModel.getProperty("/selectedCentroRecep");
			var sMaterial = oViewModel.getProperty("/selectedMaterial");
			var oEntregaRange = oView.byId("dateRangeEntrega").getDateValue();
			var oEntregaTo = oView.byId("dateRangeEntrega").getSecondDateValue();

			if (sCentroSum) {
				aFilters.push(new Filter({
					path: "centroSum",
					operator: FilterOperator.EQ,
					value1: sCentroSum
				}));
			}
			if (sCentroRecep) {
				aFilters.push(new Filter({
					path: "centroRecep",
					operator: FilterOperator.EQ,
					value1: sCentroRecep
				}));
			}
			if (sMaterial) {
				aFilters.push(new Filter({
					path: "material",
					operator: FilterOperator.EQ,
					value1: sMaterial
				}));
			}
			if (oEntregaRange && oEntregaTo) {
				aFilters.push(new Filter({
					path: "entrega",
					operator: FilterOperator.BT,
					value1: this._formatDate(oEntregaRange),
					value2: this._formatDate(oEntregaTo)
				}));
			} else if (oEntregaRange) {
				aFilters.push(new Filter("entrega", FilterOperator.EQ, this._formatDate(oEntregaRange)));
			}

			this.byId("table").getBinding("items").filter(aFilters);
		},

		/**
		 * Helper to format date as yyyy-MM-dd
		 */
		_formatDate: function (oDate) {
			if (!oDate) return "";
			var yyyy = oDate.getFullYear();
			var mm = (oDate.getMonth() + 1).toString().padStart(2, '0');
			var dd = oDate.getDate().toString().padStart(2, '0');
			return yyyy + "-" + mm + "-" + dd;
		},
		/**
		 * Event handler for FilterBar search event
		 * @public
		 */
		onFilterBarSearch: function (oEvent) {
			var oView = this.getView();
			var oViewModel = this.getModel("worklistView");
			var aFilters = [];
			var sCentroSum = oViewModel.getProperty("/selectedCentroSum");
			var sCentroRecep = oViewModel.getProperty("/selectedCentroRecep");
			var sMaterial = oViewModel.getProperty("/selectedMaterial");
			var oEntregaRange = oView.byId("dateRangeEntrega").getDateValue();
			var oEntregaTo = oView.byId("dateRangeEntrega").getSecondDateValue();

			if (sCentroSum) {
				aFilters.push(new Filter("centroSum", FilterOperator.EQ, sCentroSum));
			}
			if (sCentroRecep) {
				aFilters.push(new Filter("centroRecep", FilterOperator.EQ, sCentroRecep));
			}
			if (sMaterial) {
				aFilters.push(new Filter("material", FilterOperator.EQ, sMaterial));
			}
			if (oEntregaRange && oEntregaTo) {
				aFilters.push(new Filter({
					path: "entrega",
					operator: FilterOperator.BT,
					value1: this._formatDate(oEntregaRange),
					value2: this._formatDate(oEntregaTo)
				}));
			} else if (oEntregaRange) {
				aFilters.push(new Filter("entrega", FilterOperator.EQ, this._formatDate(oEntregaRange)));
			}

			this.byId("table").getBinding("items").filter(aFilters);
		},

		/**
		 * Helper to format date as yyyy-MM-dd
		 */
		_formatDate: function (oDate) {
			if (!oDate) return "";
			var yyyy = oDate.getFullYear();
			var mm = (oDate.getMonth() + 1).toString().padStart(2, '0');
			var dd = oDate.getDate().toString().padStart(2, '0');
			return yyyy + "-" + mm + "-" + dd;
		},

		/* =========================================================== */
		/* event handlers                                              */
		/* =========================================================== */

		/**
		 * Triggered by the table's 'updateFinished' event: after new table
		 * data is available, this handler method updates the table counter.
		 * This should only happen if the update was successful, which is
		 * why this handler is attached to 'updateFinished' and not to the
		 * table's list binding's 'dataReceived' method.
		 * @param {sap.ui.base.Event} oEvent the update finished event
		 * @public
		 */
		onUpdateFinished: function (oEvent) {
			// update the worklist's object counter after the table update
			var sTitle,
				oTable = oEvent.getSource(),
				oViewModel = this.getModel("worklistView"),
				iTotalItems = oEvent.getParameter("total");
			// only update the counter if the length is final and
			// the table is not empty
			if (iTotalItems && oTable.getBinding("items").isLengthFinal()) {
				sTitle = this.getResourceBundle().getText("worklistTableTitleCount", [iTotalItems]);
				oViewModel.setProperty("/countAll", iTotalItems);
			} else {
				sTitle = this.getResourceBundle().getText("worklistTableTitle");
			}
			this.getModel("worklistView").setProperty("/worklistTableTitle", sTitle);
		},

		/**
		 * Event handler when a table item gets pressed
		 * @param {sap.ui.base.Event} oEvent the table selectionChange event
		 * @public
		 */
		onPress: function (oEvent) {
			// The source is the list item that got pressed
			this._showObject(oEvent.getSource());
		},

		/**
		 * Event handler for navigating back.
		 * We navigate back in the browser history
		 * @public
		 */
		onNavBack: function () {
			history.go(-1);
		},


		onSearch: function (oEvent) {
			if (oEvent.getParameters().refreshButtonPressed) {
				this.onRefresh();
			} else {
				var aTableSearchState = [];
				var sQuery = oEvent.getParameter("query");
				// Search by pedido, material, descripcion, factura
				if (sQuery && sQuery.length > 0) {
					aTableSearchState = [
						new Filter({
							filters: [
								new Filter("pedido", FilterOperator.Contains, sQuery),
								new Filter("material", FilterOperator.Contains, sQuery),
								new Filter("descripcion", FilterOperator.Contains, sQuery),
								new Filter("factura", FilterOperator.Contains, sQuery)
							],
							and: false
						})
					];
				}
				this._applySearch(aTableSearchState);
			}
		},

		/**
		 * Event handler for refresh event. Keeps filter, sort
		 * and group settings and refreshes the list binding.
		 * @public
		 */
		onRefresh: function () {
			var oTable = this.byId("table");
			oTable.getBinding("items").refresh();
		},

		/* =========================================================== */
		/* internal methods                                            */
		/* =========================================================== */

		/**
		 * Shows the selected item on the object page
		 * On phones a additional history entry is created
		 * @param {sap.m.ObjectListItem} oItem selected Item
		 * @private
		 */
		_showObject: function (oItem) {
			// Example: show pedido details (customize as needed)
			var pedidoId = oItem.getBindingContext("pedidos").getProperty("pedido");
			// You can implement navigation or a dialog here
			// this.getRouter().navTo("object", { objectId: pedidoId });
		},

		/**
		 * Internal helper method to apply both filter and search state together on the list binding
		 * @param {sap.ui.model.Filter[]} aTableSearchState An array of filters for the search
		 * @private
		 */
		_applySearch: function (aTableSearchState) {
			var oTable = this.byId("table"),
				oViewModel = this.getModel("worklistView");
			oTable.getBinding("items").filter(aTableSearchState, "Application");
			if (aTableSearchState.length !== 0) {
				oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("worklistNoDataWithSearchText"));
			} else {
				oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("tableNoDataText"));
			}
		},

		/**
		 * Event handler when a filter tab gets pressed
		 * @param {sap.ui.base.Event} oEvent the filter tab event
		 * @public
		 */
		onQuickFilter: function (oEvent) {
			var oBinding = this._oTable.getBinding("items"),
				sKey = oEvent.getParameter("selectedKey"),
				aFilters = [],
				oViewModel = this.getModel("worklistView");

			// Set column visibility based on selected tab
			if (sKey === "inicial") {
				oViewModel.setProperty("/colStatusFacturacionVisible", false);
				oViewModel.setProperty("/colFacturaVisible", false);
				oViewModel.setProperty("/colStatusEnvioSunatVisible", false);
				oViewModel.setProperty("/colReferenciaVisible", false);
				oViewModel.setProperty("/colStatusMIROVisible", false);
				oViewModel.setProperty("/colDocMIROVisible", false);
				oViewModel.setProperty("/tableSelectionMode", "MultiSelect");
				oViewModel.setProperty("/processBtnVisible", true);
				aFilters = [
					new Filter("factura", FilterOperator.EQ, ""),
					new Filter("statusFacturacionId", FilterOperator.EQ, 1)
				];
			} else if (sKey === "facturadoSAP") {
				oViewModel.setProperty("/colStatusFacturacionVisible", true);
				oViewModel.setProperty("/colFacturaVisible", true);
				oViewModel.setProperty("/colStatusEnvioSunatVisible", false);
				oViewModel.setProperty("/colReferenciaVisible", false);
				oViewModel.setProperty("/colStatusMIROVisible", false);
				oViewModel.setProperty("/colDocMIROVisible", false);
				oViewModel.setProperty("/tableSelectionMode", "MultiSelect");
				oViewModel.setProperty("/processBtnVisible", true);
				aFilters = [
					new Filter("factura", FilterOperator.NE, ""),
					new Filter("statusFacturacionId", FilterOperator.EQ, 2),
					new Filter("referencia", FilterOperator.EQ, ""),
					new Filter("statusEnvioSunatId", FilterOperator.EQ, 1)
				];
			} else if (sKey === "enviadoSUNAT") {
				oViewModel.setProperty("/colStatusFacturacionVisible", true);
				oViewModel.setProperty("/colFacturaVisible", true);
				oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
				oViewModel.setProperty("/colReferenciaVisible", true);
				oViewModel.setProperty("/colStatusMIROVisible", false);
				oViewModel.setProperty("/colDocMIROVisible", false);
				oViewModel.setProperty("/tableSelectionMode", "MultiSelect");
				oViewModel.setProperty("/processBtnVisible", true);
				aFilters = [
					new Filter("referencia", FilterOperator.NE, ""),
					new Filter("statusEnvioSunatId", FilterOperator.EQ, 2),
					new Filter("docMiro", FilterOperator.EQ, ""),
					new Filter("statusMiroId", FilterOperator.EQ, 1)
				];
			} else if (sKey === "registradoMIRO") {
				oViewModel.setProperty("/colStatusFacturacionVisible", true);
				oViewModel.setProperty("/colFacturaVisible", true);
				oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
				oViewModel.setProperty("/colReferenciaVisible", true);
				oViewModel.setProperty("/colStatusMIROVisible", true);
				oViewModel.setProperty("/colDocMIROVisible", true);
				oViewModel.setProperty("/tableSelectionMode", "None");
				oViewModel.setProperty("/processBtnVisible", false);
				aFilters = [
					new Filter("docMiro", FilterOperator.NE, ""),
					new Filter("statusMiroId", FilterOperator.EQ, 2)
				];
			}

			oBinding.filter(aFilters);
		},


		/**
		 * Handles table selection change to update selected row count
		 */
		onSelectionChange: function (oEvent) {
			var oTable = this.byId("table");
			var aSelectedIndices = oTable.getSelectedIndices ? oTable.getSelectedIndices() : oTable.getSelectedContexts();
			var count = 0;
			if (Array.isArray(aSelectedIndices)) {
				count = aSelectedIndices.length;
			} else if (aSelectedIndices && typeof aSelectedIndices === 'object' && aSelectedIndices.getLength) {
				count = aSelectedIndices.getLength();
			}
			this.getModel("worklistView").setProperty("/selectedRowsCount", count);
		},

		/**
		 * Handler for processing selected rows (stub)
		 */
		onProcessSelected: function () {
			var oTable = this.byId("table");
			var aSelectedContexts = oTable.getSelectedContexts();
			var aSelectedData = aSelectedContexts.map(function (ctx) {
				return ctx.getObject();
			});
			var aMismatches = aSelectedData.filter(function (row) {
				return row._mismatch;
			});
			var that = this;
			function processValidRows(aValidRows, selectedDate) {
				// TODO: Call backend with aValidRows and selectedDate if needed
				var msg = aValidRows.length + " filas válidas serán procesadas";
				if (selectedDate) {
					msg += " con fecha " + selectedDate;
				}
				sap.m.MessageToast.show(msg);
			}
			function promptForDateAndProcess(aValidRows) {
				if (that._oDateDialog) {
					that._oDateDialog.destroy();
				}
				that._oDateDialog = new sap.m.Dialog({
					title: "Seleccionar fecha de contabilización",
					type: "Message",
					content: [
						new sap.m.Label({ text: "Por favor seleccione la fecha de contabilización:" }),
						new sap.m.DatePicker("datePickerContab", {
							valueFormat: "yyyy-MM-dd",
							displayFormat: "dd.MM.yyyy",
							required: true
						})
					],
					beginButton: new sap.m.Button({
						text: "Aceptar",
						type: "Emphasized",
						press: function () {
							var oDatePicker = sap.ui.getCore().byId("datePickerContab");
							var oDate = oDatePicker.getDateValue();
							if (!oDate) {
								oDatePicker.setValueState("Error");
								oDatePicker.setValueStateText("Debe seleccionar una fecha");
								return;
							}
							var yyyy = oDate.getFullYear();
							var mm = (oDate.getMonth() + 1).toString().padStart(2, '0');
							var dd = oDate.getDate().toString().padStart(2, '0');
							var sDate = yyyy + "-" + mm + "-" + dd;
							that._oDateDialog.close();
							processValidRows(aValidRows, sDate);
						}
					}),
					endButton: new sap.m.Button({
						text: "Cancelar",
						press: function () { that._oDateDialog.close(); }
					}),
					afterClose: function () {
						that._oDateDialog.destroy();
					}
				});
				that._oDateDialog.open();
			}
			// Always show mismatches dialog if mismatches exist
			if (aMismatches.length > 0) {
				if (this._oMismatchDialog) {
					this._oMismatchDialog.destroy();
				}
				this._oMismatchDialog = new sap.m.Dialog({
					title: "Filas con diferencias Cant. Salida vs Cant. Entrega",
					contentWidth: "600px",
					type: "Message",
					content: [
						new sap.m.Text({
							text: "Las siguientes filas tienen diferencias entre Cant. Salida y Cant. Entrega \ny no serán enviadas para su procesamiento. \n¿Desea continuar con las filas válidas o cancelar la acción?",
							wrapping: true,
							design: "Bold"
						}),
						new sap.m.Table({
							columns: [
								new sap.m.Column({ header: new sap.m.Label({ text: "Pedido" }) }),
								new sap.m.Column({ header: new sap.m.Label({ text: "Material" }) }),
								new sap.m.Column({ header: new sap.m.Label({ text: "Cant. Salida" }) }),
								new sap.m.Column({ header: new sap.m.Label({ text: "Cant. Entrega" }) })
							],
							items: {
								path: "/mismatches",
								template: new sap.m.ColumnListItem({
									cells: [
										new sap.m.Text({ text: "{pedido}" }),
										new sap.m.Text({ text: "{material}" }),
										new sap.m.Text({ text: "{cantSal}" }),
										new sap.m.Text({ text: "{cantEnt}" })
									]
								})
							}
						})
					],
					beginButton: new sap.m.Button({
						text: "Continuar",
						type: "Emphasized",
						press: function () {
							that._oMismatchDialog.close();
							var aValidRows = aSelectedData.filter(function (row) { return !row._mismatch; });
							// Check if "Inicial" tab is selected
							var oIconTabBar = that.byId && that.byId("iconTabBar");
							var sKey = oIconTabBar ? oIconTabBar.getSelectedKey() : null;
							if (sKey === "inicial") {
								promptForDateAndProcess(aValidRows);
							} else {
								processValidRows(aValidRows);
							}
						}
					}),
					endButton: new sap.m.Button({
						text: "Cancelar",
						press: function () { that._oMismatchDialog.close(); }
					}),
					afterClose: function () {
						that._oMismatchDialog.destroy();
					}
				});
				var oMismatchModel = new sap.ui.model.json.JSONModel({ mismatches: aMismatches });
				this._oMismatchDialog.setModel(oMismatchModel);
				this._oMismatchDialog.open();
			} else {
				// No mismatches, check if "Inicial" tab is selected
				var oIconTabBar = this.byId && this.byId("iconTabBar");
				var sKey = oIconTabBar ? oIconTabBar.getSelectedKey() : null;
				if (sKey === "inicial") {
					promptForDateAndProcess(aSelectedData);
				} else {
					processValidRows(aSelectedData);
				}
			}
		},

		onMessagesButtonPress: function(oEvent) {
			var oMessagesButton = oEvent.getSource();

			if (!this._messagePopover) {
				this._messagePopover = new MessagePopover({
					items: {
						path: "message>/",
						template: new MessageItem({
							description: "{message>description}",
							type: "{message>type}",
							title: "{message>message}"
						})
					}
				});
				oMessagesButton.addDependent(this._messagePopover);
			}
			this._messagePopover.toggle(oMessagesButton);
		}
	});

});