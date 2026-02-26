sap.ui.define([
    "./BaseController",
    "sap/ui/model/json/JSONModel",
    "com/nttdata/cuentas/model/formatter",
    "sap/ui/model/Filter",
    "sap/ui/model/FilterOperator",
    "sap/ui/model/FilterType",
    "sap/ui/core/Messaging",
    "sap/ui/core/message/ControlMessageProcessor",
    "sap/ui/core/message/Message",
    "sap/ui/core/message/MessageType",
    "sap/m/MessagePopover",
    "sap/m/MessageItem",
    "sap/m/MessageBox",
    "sap/m/MessageToast",
	"sap/ui/unified/Menu",
	"sap/ui/unified/MenuItem",
	"sap/ui/unified/MenuTextFieldItem",
	"sap/ui/table/library",
    "sap/ui/export/Spreadsheet",
    "sap/ui/export/library"
], function (
    BaseController,
    JSONModel,
    formatter,
    Filter,
    FilterOperator,
    FilterType,
    Messaging,
    ControlMessageProcessor,
    Message,
    MessageType,
    MessagePopover,
    MessageItem,
    MessageBox,
    MessageToast,
	Menu,
	MenuItem,
	MenuTextFieldItem,
	tableLibrary,
    Spreadsheet,
    exportLibrary
) {
    "use strict";

    return BaseController.extend("com.nttdata.cuentas.controller.Worklist", {
        formatter: formatter,

        onInit: function () {
            var oTable = this.byId("table");
            this._oTable = oTable;
            this._aTableSearchState = [];
            this._aQuickFilterState = [];

            var oViewModel = new JSONModel({
                worklistTableTitle: this.getResourceBundle().getText("worklistTableTitle"),
                shareOnJamTitle: this.getResourceBundle().getText("worklistTitle"),
                shareSendEmailSubject: this.getResourceBundle().getText("shareSendEmailWorklistSubject"),
                shareSendEmailMessage: this.getResourceBundle().getText("shareSendEmailWorklistMessage", [location.href]),
                tableNoDataText: this.getResourceBundle().getText("tableNoDataText"),
                tableBusyDelay: 0,

                // Column visibility flags by "Estado"
                colStatusFacturacionVisible: true,
                colFacturaVisible: true,
                colStatusEnvioSunatVisible: true,
                colReferenciaVisible: true,
                colStatusMIROVisible: true,
                colDocMIROVisible: true,

                // Filter options (filled from OData)
                centroSumOptions: [],
                centroRecepOptions: [],
                materialOptions: [],
                estadoRegOptions: [],

                // EstadoFiltroSet options (by TipoProc)
                statusFactOptions: [],
                statusSunatOptions: [],
                statusMiroOptions: [],

                // Selected filters
                selectedCentroSum: "",
                selectedCentroRecep: [],
                selectedMaterial: "",
                selectedEstadoReg: [],

                // Selected EstadoFiltroSet filters
                selectedStatusFact: [],
                selectedStatusSunat: [],
                selectedStatusMiro: [],

                // Table / toolbar state
                selectedRowsCount: 0,
                tableSelectionMode: "MultiToggle",
                processBtnVisible: true,

                // 3 procesos (botones)
                facturarBtnVisible: true,
                sunatBtnVisible: false,
                miroBtnVisible: false,
                reproBtnVisible: false,

                // habilitación (según selección + validaciones)
                canFacturar: false,
                canSunat: false,
                canMiro: false,
                canRepro: false
            });
            this.setModel(oViewModel, "worklistView");

            // Pedidos model (table datasource) - we keep JSONModel to avoid touching the XML view/styles.
            this.getView().setModel(new JSONModel([]), "pedidos");

            // Set message model for MessagesIndicator
            var oMessageManager = sap.ui.getCore().getMessageManager();
            this.getView().setModel(oMessageManager.getMessageModel(), "message");

            // Load filter options from the real service (articuloModel -> articuloService in manifest)
            this._loadFilterOptions();

			// Add "quick filters" (selectable options) for Estado Tolerancia
			// NOTE: The standard GridTable column menu is internal and NOT returned by Column#getMenu().
			// To add items reliably, we set a custom Menu on that specific column (menu aggregation)
			// and reproduce the standard actions (sort + filter) there.
			this._setupEstadoTolColumnMenu();
			this._setupEstadoRegColumnMenu();
			this._setupStatusFactColumnMenu();
			this._setupStatusSunatColumnMenu();
			this._setupStatusMiroColumnMenu();

            // Keep count/scroll in sync when column filters change
            oTable.attachFilter(this._onTableColumnFilter, this);


            // Keep original busy delay after first data update
            var iOriginalBusyDelay = oTable.getBusyIndicatorDelay();
            oTable.attachEventOnce("rowsUpdated", function () {
                oViewModel.setProperty("/tableBusyDelay", iOriginalBusyDelay);
            });

            // Message processor for MessagesIndicator (messages are pushed per backend response)
            var oMessageProcessor = new ControlMessageProcessor();
            Messaging.registerMessageProcessor(oMessageProcessor);
            this._oMessageProcessor = oMessageProcessor;
        },

        /* =========================================================== */
        /*  OData (articuloService)                                    */
        /* =========================================================== */

        _getArticuloModel: function () {
            return this.getOwnerComponent().getModel("articuloModel");
        },

        _loadFilterOptions: function () {
            var oViewModel = this.getModel("worklistView");
            var oODataModel = this._getArticuloModel();

            // 1) Grupo de Material: /GrupoArticuloSet
            oODataModel.read("/GrupoArticuloSet", {
                success: function (oData) {
                    var aResults = (oData && oData.results) ? oData.results : [];
                    var aOptions = this._toOptions(aResults, [
                        "Extwg", "GRUPO", "Grupo", "Key", "ID", "Id", "Codigo", "Code"
                    ], [
                        "Ewbez", "Descripcion", "Descripción", "Text", "Name", "Nombre", "Desc", "Description"
                    ]);
                    oViewModel.setProperty("/materialOptions", aOptions);
                }.bind(this),
                error: function (oError) {
                    // Keep app usable even if this fails
                    MessageBox.error(this._formatODataError(oError, "No se pudo cargar Grupo de Material (/GrupoArticuloSet)."));
                }.bind(this)
            });

            // 2) Centros: /CentroHeaderSet('1')?$expand=CCompradorNav,CVendedorNav
            oODataModel.read("/CentroHeaderSet('1')", {
                urlParameters: {
                    "$expand": "CCompradorNav,CVendedorNav"
                },
success: function (oData) {
    var aComprador = (oData && oData.CCompradorNav && oData.CCompradorNav.results) ? oData.CCompradorNav.results : [];
    var aVendedor  = (oData && oData.CVendedorNav  && oData.CVendedorNav.results)  ? oData.CVendedorNav.results  : [];

    // ✅ Centro Comprador: key=Kunnr, text=Name1
    var aCentroCompOptions = this._toOptions(aComprador, ["Kunnr"], ["Name1"]);

    // ✅ Fallback dummy SOLO si no hay compradores
    if (!aCentroCompOptions.length) {
        aCentroCompOptions = [
            { key: "000000000001", text: "000000000001 - (Dummy)" }
        ];

        // (Opcional) preseleccionar el dummy para que puedas probar sin tocar nada más
        if (!oViewModel.getProperty("/selectedCentroRecep")) {
            oViewModel.setProperty("/selectedCentroRecep", []);
        }
    }

    // ✅ Centro Vendedor: key=Lifnr, text=Name1
    var aCentroVendOptions = this._toOptions(aVendedor, ["Lifnr"], ["Name1"]);

    oViewModel.setProperty("/centroRecepOptions", aCentroCompOptions);
    oViewModel.setProperty("/centroSumOptions", aCentroVendOptions);

    // Enrich current table rows (if already loaded) with center descriptions
    this._enrichCentroDescriptions();
}.bind(this),

                error: function (oError) {
                    MessageBox.error(this._formatODataError(oError, "No se pudo cargar Centros (/CentroHeaderSet('1') expand)."));
                }.bind(this)
            });
            // 3) Estado de Registro: /EstadoRegistroSet
            oODataModel.read("/EstadoRegistroSet", {
                success: function (oData) {
                    var aResults = (oData && oData.results) ? oData.results : [];
                    var aOptions = aResults.map(function (oItem) {
                        var sDesc = (oItem && (oItem.DesEstado || oItem.Desestado || oItem.DESESTADO)) || "";
                        sDesc = String(sDesc).trim();
                        if (!sDesc) return null;
                        return { key: sDesc, text: sDesc };
                    }).filter(Boolean);

                    oViewModel.setProperty("/estadoRegOptions", aOptions);
                }.bind(this),
                error: function (oError) {
                    MessageBox.error(this._formatODataError(oError, "No se pudo cargar Estado de Registro (/EstadoRegistroSet)."));
                }.bind(this)
            });

            // 4) Estados por proceso: /EstadoFiltroSet (TipoProc -> DescEstd)
            oODataModel.read("/EstadoFiltroSet", {
                success: function (oData) {
                    var aResults = (oData && oData.results) ? oData.results : [];
                    var mByTipo = { FACT: [], ENSN: [], MIRO: [] };

                    aResults.forEach(function (r) {
                        if (!r) return;
                        var sTipo = (r.TipoProc == null) ? "" : String(r.TipoProc).trim().toUpperCase();
                        var sDesc = (r.DescEstd == null) ? "" : String(r.DescEstd).trim();
                        if (!sTipo || !sDesc) return;
                        if (!mByTipo[sTipo]) mByTipo[sTipo] = [];
                        mByTipo[sTipo].push({ key: sDesc, text: sDesc });
                    });

                    var fnUniq = function (a) {
                        var m = {};
                        return (a || []).filter(function (x) {
                            var k = x && x.key;
                            if (!k) return false;
                            if (m[k]) return false;
                            m[k] = true;
                            return true;
                        });
                    };

                    oViewModel.setProperty("/statusFactOptions", fnUniq(mByTipo.FACT));
                    oViewModel.setProperty("/statusSunatOptions", fnUniq(mByTipo.ENSN));
                    oViewModel.setProperty("/statusMiroOptions", fnUniq(mByTipo.MIRO));

                    // Re-crear menús de columna para que las "Sugerencias" ya incluyan EstadoFiltroSet
                    // (FACT -> Status Facturación, ENSN -> Status Envío SUNAT, MIRO -> Status MIRO)
                    this._refreshEstadoFiltroColumnMenus();
                }.bind(this),
                error: function (oError) {
                    // No bloquea el uso de la app
                    MessageBox.error(this._formatODataError(oError, "No se pudo cargar Estados por Proceso (/EstadoFiltroSet)."));
                }.bind(this)
            });


        },

        /**
         * Build options list {key, text} trying multiple candidate properties.
         * This keeps the XML view untouched: ComboBox uses worklistView>/...Options with key/text.
         */
        _toOptions: function (aItems, aKeyCandidates, aTextCandidates) {
            var that = this;

            if (!Array.isArray(aItems)) {
                return [];
            }

            return aItems.map(function (oItem) {
                var sKey = that._pickFirstExisting(oItem, aKeyCandidates) || that._guessKey(oItem);
                var sText = that._pickFirstExisting(oItem, aTextCandidates) || sKey;

                if (sKey == null) {
                    return null;
                }
                sKey = String(sKey).trim();
                sText = (sText == null) ? "" : String(sText).trim();

                if (!sKey) {
                    return null;
                }

                var sDisplay = (sText && sText !== sKey) ? (sKey + " - " + sText) : sKey;
                return { key: sKey, text: sDisplay };
            }).filter(Boolean);
        },

        _pickFirstExisting: function (o, aCandidates) {
            if (!o || !aCandidates) return "";
            for (var i = 0; i < aCandidates.length; i++) {
                var p = aCandidates[i];
                if (Object.prototype.hasOwnProperty.call(o, p) && o[p] != null && String(o[p]).trim() !== "") {
                    return o[p];
                }
            }
            return "";
        },

        _guessKey: function (o) {
            if (!o) return "";
            // try to pick the first primitive string/number property (ignoring metadata)
            var aKeys = Object.keys(o).filter(function (k) { return k !== "__metadata"; });
            for (var i = 0; i < aKeys.length; i++) {
                var v = o[aKeys[i]];
                if (v == null) continue;
                if (typeof v === "string" && v.trim() !== "") return v;
                if (typeof v === "number") return String(v);
            }
            return "";
        },

        /**
         * Returns description text for a given key from a [{key,text}] options array.
         * If option.text is 'KEY - DESC', we return only 'DESC'.
         */
        _getOptionDescByKey: function (aOptions, sKey) {
            if (!sKey) return "";
            if (!Array.isArray(aOptions)) return "";

            var oFound = aOptions.find(function (o) {
                return o && String(o.key) === String(sKey);
            });

            if (!oFound || !oFound.text) return "";

            var sText = String(oFound.text);
            var sPrefix = String(sKey) + " - ";
            if (sText.indexOf(sPrefix) === 0) {
                return sText.slice(sPrefix.length);
            }
            return (sText === String(sKey)) ? "" : sText;
        },

        _enrichCentroDescriptions: function () {
            var oPedidosModel = this.getModel("pedidos");
            var aData = (oPedidosModel && oPedidosModel.getData) ? oPedidosModel.getData() : [];
            if (!Array.isArray(aData) || aData.length === 0) return;

            var oViewModel = this.getModel("worklistView");
            var aCentroVendOptions = (oViewModel && oViewModel.getProperty) ? (oViewModel.getProperty("/centroSumOptions") || []) : [];
            var aCentroCompOptions = (oViewModel && oViewModel.getProperty) ? (oViewModel.getProperty("/centroRecepOptions") || []) : [];

            aData.forEach(function (row) {
                if (!row) return;
                row.centroSumDesc = this._getOptionDescByKey(aCentroVendOptions, row.centroSum);
                row.centroRecepDesc = this._getOptionDescByKey(aCentroCompOptions, row.centroRecep);
            }.bind(this));

            // Trigger UI refresh
            if (oPedidosModel && oPedidosModel.refresh) {
                oPedidosModel.refresh(true);
            }
        },


        _loadDocumentoMonitor: function (aFilters) {
            var oODataModel = this._getArticuloModel();
            var oTable = this.byId("table");

            oTable.setBusy(true);

            oODataModel.read("/DocumentoMonitorSet", {
                filters: aFilters || [],
                success: function (oData) {
                    var aResults = (oData && oData.results) ? oData.results : [];
                    var aMapped = aResults.map(function (oRow) {
                        return this._mapDocumentoMonitorRow(oRow);
                    }.bind(this));

                    this.getModel("pedidos").setData(aMapped);

                    // Add center descriptions based on loaded filter options
                    this._enrichCentroDescriptions();

                    // Reset selection count
                    this.getModel("worklistView").setProperty("/selectedRowsCount", 0);
                    oTable.clearSelection();

                    oTable.setBusy(false);
                }.bind(this),
                error: function (oError) {
                    oTable.setBusy(false);
                    MessageBox.error(this._formatODataError(oError, "Error al obtener DocumentoMonitor (/DocumentoMonitorSet)."));
                }.bind(this)
            });
        },

        _mapDocumentoMonitorRow: function (o) {
            var nCantSal = this._toNumber(o.CantSal);
            var nCantEnt = this._toNumber(o.CantEnt);
            var nImpSal = this._toNumber(o.ImporteSal);
            var nImpEnt = this._toNumber(o.ImporteEnt);

            var nDifCant = (o.DifCantidad != null) ? this._toNumber(o.DifCantidad) : (nCantSal - nCantEnt);
            var nDifImp = nImpSal - nImpEnt;


            // Center descriptions based on filter options (key -> name)
            var oViewModel = this.getModel("worklistView");
            var aCentroVendOptions = oViewModel ? (oViewModel.getProperty("/centroSumOptions") || []) : [];
            var aCentroCompOptions = oViewModel ? (oViewModel.getProperty("/centroRecepOptions") || []) : [];
            var sCentroVend = o.CentroVend || "";
            var sCentroComp = o.CentroComp || "";
            var sCentroVendDesc = this._getOptionDescByKey(aCentroVendOptions, sCentroVend);
            var sCentroCompDesc = this._getOptionDescByKey(aCentroCompOptions, sCentroComp);
            // Flag mismatch to keep existing highlight/styling
            var bMismatch = (nDifCant !== 0) || (nDifImp !== 0);

            return {
                // Visible in UI
                pedido: o.Ebeln || "",
                idItem: (o.IdItem || ((o.Ebeln || "") + "_" + (o.Ebelp || ""))),
                pos: o.Ebelp || "",
                material: o.Matnr || "",
                descripcion: o.Maktx || "",
                tipoRetencion: o.TipoRet || "",
                entrega: this._formatODataDate(o.Entrega),
                centroSum: sCentroVend,
                centroSumDesc: sCentroVendDesc,
                centroRecep: sCentroComp,
                centroRecepDesc: sCentroCompDesc,
                cantSal: nCantSal,
                cantEnt: nCantEnt,
                precioSal: nImpSal,
                precioEnt: nImpEnt,
                statusFacturacion: (o.StatusFact == null) ? "" : String(o.StatusFact).trim(),
                factura: (o.Factura == null) ? "" : String(o.Factura).trim(),
                statusEnvioSunat: (o.StatusEnvSunat == null) ? "" : String(o.StatusEnvSunat).trim(),
                referencia: (o.Referencia == null) ? "" : String(o.Referencia).trim(),
                statusMiro: (o.StatusMiro == null) ? "" : String(o.StatusMiro).trim(),
                docMiro: (o.DocMiro == null) ? "" : String(o.DocMiro),
                mensajeUltimoEvento: (o.MsjUltEvento == null) ? "" : String(o.MsjUltEvento).trim(),

                // Extra fields from the entity (not necessarily visible yet)
                docSal643: (o.DocSal643 == null) ? "" : String(o.DocSal643),
                docEnt101: (o.DocEnt101 == null) ? "" : String(o.DocEnt101),
ejercicio643: (o.Ejercicio643 == null) ? "" : String(o.Ejercicio643),
posicion643: (o.Posicion643 == null) ? "" : String(o.Posicion643),
				// EstadoTol puede venir como 1/0/-1. Si viene vacío, lo dejamos vacío (formatter lo interpreta como 🟢).
				estadoTol: (o.EstadoTol == null || o.EstadoTol === "") ? "" : Number(o.EstadoTol),
                estadoReg: (o.EstadoReg == null) ? "" : String(o.EstadoReg).trim(),
                budat: this._formatODataDate(o.Budat),
                extwg: o.Extwg || "",

                // Calculated fields (helpful for export)
                difCantidadCalc: nCantSal - nCantEnt,
                difImporteCalc: nDifImp,

                // Highlight flag
                _mismatch: bMismatch
            };
        },

        _toNumber: function (v) {
            if (v == null || v === "") return 0;
            var n = Number(v);
            return isNaN(n) ? 0 : n;
        },

        _formatODataDate: function (v) {
            // OData V2 can return Date or /Date(...)/
            var oDate = null;

            if (v instanceof Date) {
                oDate = v;
            } else if (typeof v === "string") {
                var m = /\/Date\((\d+)\)\//.exec(v);
                if (m) {
                    oDate = new Date(parseInt(m[1], 10));
                } else {
                    // if it's already a yyyy-mm-dd string, keep it
                    return v;
                }
            }

            if (!oDate) return "";

            var yyyy = oDate.getFullYear();
            var mm = String(oDate.getMonth() + 1).padStart(2, "0");
            var dd = String(oDate.getDate()).padStart(2, "0");
            return yyyy + "-" + mm + "-" + dd;
        },

        _formatODataError: function (oError, sFallback) {
            try {
                // Try to extract SAP Gateway message
                var sText = (oError && oError.responseText) ? oError.responseText : "";
                if (sText) {
                    var o = JSON.parse(sText);
                    var sMsg = o && o.error && o.error.message && o.error.message.value;
                    if (sMsg) return sMsg;
                }
            } catch (e) {
                // ignore
            }
            return sFallback || "Error OData.";
        },

        _clearFilterValueStates: function () {
            var oCentroVend = this.byId("selectCentroSum");
            var oCentroComp = this.byId("selectCentroRecep");
            var oGrupoMat = this.byId("selectMaterial");
            var oDateRange = this.byId("dateRangeEntrega");

            var oEstadoReg = this.byId("selectEstadoReg");

            var oStatusFact = this.byId("selectStatusFact");
            var oStatusSunat = this.byId("selectStatusSunat");
            var oStatusMiro = this.byId("selectStatusMiro");

            [oCentroVend, oCentroComp, oGrupoMat, oDateRange, oEstadoReg, oStatusFact, oStatusSunat, oStatusMiro].forEach(function (oCtrl) {
                if (oCtrl && oCtrl.setValueState) {
                    oCtrl.setValueState("None");
                    oCtrl.setValueStateText("");
                }
            });
        },

		/* =========================================================== */
		/*  Column Menu enhancements                                   */
		/* =========================================================== */

		/**
		 * Why your items didn't show up:
		 * - The menu you see (Sort/Filter/Columns) is the INTERNAL ColumnMenu created by sap.ui.table.Table.
		 * - That internal menu is NOT exposed via Column#getMenu().
		 *
		 * To add selectable "suggestions" reliably (without hacking private APIs), we set a CUSTOM
		 * sap.ui.unified.Menu on this specific column (menu aggregation) and reproduce the standard
		 * actions (Sort Asc/Desc, Filter, Columns submenu) plus our quick filters.
		 */
		_setupEstadoTolColumnMenu: function () {
			var oCol = this.byId("colEstadoTol");
			var oTable = this.byId("table");
			if (!oCol || !oTable || !oCol.setMenu) {
				return;
			}

			// If a custom menu is already set, do nothing.
			if (oCol.getMenu && oCol.getMenu()) {
				return;
			}

			var that = this;
			var oMenu = new Menu(this.getView().createId("estadoTolMenu"));

			// 1) Standard actions (replicated)
			oMenu.addItem(new MenuItem({
				text: "Sort Ascending",
				icon: "sap-icon://sort-ascending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Ascending); } catch (e) { /* ignore */ }
				}
			}));
			oMenu.addItem(new MenuItem({
				text: "Sort Descending",
				icon: "sap-icon://sort-descending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Descending); } catch (e) { /* ignore */ }
				}
			}));

			var oFilterItem = new MenuTextFieldItem({
				label: "Filter",
				icon: "sap-icon://filter",
				value: (oCol.getFilterValue ? (oCol.getFilterValue() || "") : ""),
				select: function () {
					var sVal = oFilterItem.getValue();
					try {
						oCol.setFilterValue(sVal);
						oTable.filter(oCol, sVal);
					} catch (e) { /* ignore */ }
				}
			});
			oMenu.addItem(oFilterItem);

			// Keep the filter text field in sync whenever the menu opens
			if (oMenu.attachBeforeOpen && oCol.getFilterValue) {
				oMenu.attachBeforeOpen(function () {
					try { oFilterItem.setValue(oCol.getFilterValue() || ""); } catch (e) { /* ignore */ }
				});
			}

			// 2) Quick filters (EstadoTol: 🟢=1, 🟡=0, 🔴=-1)
			oMenu.addItem(new MenuItem({
				text: "Sugerencias",
				startsSection: true,
				enabled: false
			}));
			oMenu.addItem(new MenuItem({
				text: "🟢 Sin diferencia",
				select: function () { that._applyEstadoTolQuickFilter(1); }
			}));
			oMenu.addItem(new MenuItem({
				text: "🟡 Dentro de tolerancia",
				select: function () { that._applyEstadoTolQuickFilter(0); }
			}));
			oMenu.addItem(new MenuItem({
				text: "🔴 Fuera de tolerancia",
				select: function () { that._applyEstadoTolQuickFilter(-1); }
			}));
			oMenu.addItem(new MenuItem({
				text: "Quitar filtro",
				select: function () { that._applyEstadoTolQuickFilter(null); }
			}));

			// 3) Columns submenu (best-effort)
			oMenu.addItem(new MenuItem({
				text: "Columns",
				startsSection: true,
				submenu: this._buildColumnsSubMenu(oTable)
			}));



			oCol.setMenu(oMenu);
		},

		_buildColumnsSubMenu: function (oTable) {
			var oSub = new Menu();
			if (!oTable || !oTable.getColumns) {
				return oSub;
			}

			var aCols = oTable.getColumns() || [];
			aCols.forEach(function (oCol) {
				if (!oCol) return;

				var sText = "";
				try {
					var oLbl = oCol.getLabel && oCol.getLabel();
					if (oLbl && oLbl.getText) {
						sText = oLbl.getText();
					}
				} catch (e) { /* ignore */ }
				if (!sText) {
					sText = (oCol.getId && oCol.getId()) ? oCol.getId() : "Column";
				}

				var oItem = new MenuItem({
					text: sText,
					icon: (oCol.getVisible && oCol.getVisible()) ? "sap-icon://accept" : "",
					select: function () {
						try {
							var bNew = !(oCol.getVisible && oCol.getVisible());
							oCol.setVisible(bNew);
							oItem.setIcon(bNew ? "sap-icon://accept" : "");
						} catch (e) { /* ignore */ }
					}
				});

				oSub.addItem(oItem);
			});
			return oSub;
		},

		_applyEstadoTolQuickFilter: function (vCode) {
			var oTable = this.byId("table");
			var oCol = this.byId("colEstadoTol");
			if (!oTable || !oCol || !oTable.filter) {
				return;
			}

			var sVal = (vCode == null) ? "" : String(vCode);
			try {
				oCol.setFilterValue(sVal);
				// Table#filter aplica la lógica estándar de filtrado por columna
				oTable.filter(oCol, sVal);
			} catch (e) {
				// ignore
			}
		},

		_setupEstadoRegColumnMenu: function () {
			var oCol = this.byId("colEstadoReg");
			var oTable = this.byId("table");
			if (!oCol || !oTable || !oCol.setMenu) {
				return;
			}

			// If a custom menu is already set, do nothing.
			if (oCol.getMenu && oCol.getMenu()) {
				return;
			}

			var that = this;
			var oMenu = new Menu(this.getView().createId("estadoRegMenu"));

			// 1) Standard actions (replicated)
			oMenu.addItem(new MenuItem({
				text: "Sort Ascending",
				icon: "sap-icon://sort-ascending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Ascending); } catch (e) { /* ignore */ }
				}
			}));
			oMenu.addItem(new MenuItem({
				text: "Sort Descending",
				icon: "sap-icon://sort-descending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Descending); } catch (e) { /* ignore */ }
				}
			}));

			var oFilterItem = new MenuTextFieldItem({
				label: "Filter",
				icon: "sap-icon://filter",
				value: (oCol.getFilterValue ? (oCol.getFilterValue() || "") : ""),
				select: function () {
					var sVal = oFilterItem.getValue();
					try {
						oCol.setFilterValue(sVal);
						oTable.filter(oCol, sVal);
					} catch (e) { /* ignore */ }
				}
			});
			oMenu.addItem(oFilterItem);

			// Keep the filter text field in sync whenever the menu opens
			if (oMenu.attachBeforeOpen && oCol.getFilterValue) {
				oMenu.attachBeforeOpen(function () {
					try { oFilterItem.setValue(oCol.getFilterValue() || ""); } catch (e) { /* ignore */ }
				});
			}

			// 2) Quick filters (EstadoReg)
			oMenu.addItem(new MenuItem({
				text: "Sugerencias",
				startsSection: true,
				enabled: false
			}));
			oMenu.addItem(new MenuItem({
				text: "En proceso",
				select: function () { that._applyEstadoRegQuickFilter("En proceso"); }
			}));
			oMenu.addItem(new MenuItem({
				text: "No procesado",
				select: function () { that._applyEstadoRegQuickFilter("No procesado"); }
			}));
			oMenu.addItem(new MenuItem({
				text: "Procesado",
				select: function () { that._applyEstadoRegQuickFilter("Procesado"); }
			}));
			oMenu.addItem(new MenuItem({
				text: "Quitar filtro",
				select: function () { that._applyEstadoRegQuickFilter(null); }
			}));

			// 3) Columns submenu (best-effort)
			oMenu.addItem(new MenuItem({
				text: "Columns",
				startsSection: true,
				submenu: this._buildColumnsSubMenu(oTable)
			}));

			oCol.setMenu(oMenu);
		},

		_applyEstadoRegQuickFilter: function (sValue) {
			var oTable = this.byId("table");
			var oCol = this.byId("colEstadoReg");
			if (!oTable || !oCol || !oTable.filter) {
				return;
			}

			var sVal = (sValue == null) ? "" : String(sValue);
			try {
				oCol.setFilterValue(sVal);
				oTable.filter(oCol, sVal);
			} catch (e) {
				// ignore
			}
		},

		_applyColumnQuickFilter: function (oCol, vValue) {
			var oTable = this.byId("table");
			if (!oTable || !oCol || !oTable.filter) {
				return;
			}

			var sVal = (vValue == null) ? "" : String(vValue);
			try {
				oCol.setFilterValue(sVal);
				oTable.filter(oCol, sVal);
			} catch (e) {
				// ignore
			}
		},

		_setupStatusFactColumnMenu: function (bForce) {
			this._setupDynamicSuggestionColumnMenu({
				colId: "colStatusFacturacion",
				menuId: "statusFactMenu",
				optionsPath: "/statusFactOptions"
			}, bForce);
		},

		_setupStatusSunatColumnMenu: function (bForce) {
			this._setupDynamicSuggestionColumnMenu({
				colId: "colStatusEnvioSunat",
				menuId: "statusSunatMenu",
				optionsPath: "/statusSunatOptions"
			}, bForce);
		},

		_setupStatusMiroColumnMenu: function (bForce) {
			this._setupDynamicSuggestionColumnMenu({
				colId: "colStatusMIRO",
				menuId: "statusMiroMenu",
				optionsPath: "/statusMiroOptions"
			}, bForce);
		},

		_refreshEstadoFiltroColumnMenus: function () {
			// Re-crea los menús de columna de Status* para que las sugerencias reflejen el contenido de /EstadoFiltroSet.
			// Esto evita "(Sin sugerencias)" cuando el usuario abre el menú antes de que termine la carga inicial.
			this._setupStatusFactColumnMenu(true);
			this._setupStatusSunatColumnMenu(true);
			this._setupStatusMiroColumnMenu(true);
		},

		_setupDynamicSuggestionColumnMenu: function (mCfg, bForce) {
			var oCol = this.byId(mCfg && mCfg.colId);
			var oTable = this.byId("table");
			if (!oCol || !oTable || !oCol.setMenu) {
				return;
			}

			// Si ya hay un menú custom, por defecto no lo recreamos (evita duplicados).
			// Pero cuando bForce=true (p.ej. luego de cargar /EstadoFiltroSet), lo destruimos y lo recreamos
			// para poblar "Sugerencias".
			var oExistingMenu = (oCol.getMenu && oCol.getMenu()) ? oCol.getMenu() : null;
			if (oExistingMenu) {
				if (!bForce) {
					return;
				}
				try { oExistingMenu.destroy(); } catch (e0) { /* ignore */ }
			}

			var that = this;
			var oMenu = new Menu(this.getView().createId(mCfg.menuId || (mCfg.colId + "Menu")));

			// 1) Standard actions (replicated)
			oMenu.addItem(new MenuItem({
				text: "Sort Ascending",
				icon: "sap-icon://sort-ascending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Ascending); } catch (e) { /* ignore */ }
				}
			}));
			oMenu.addItem(new MenuItem({
				text: "Sort Descending",
				icon: "sap-icon://sort-descending",
				select: function () {
					try { oTable.sort(oCol, tableLibrary.SortOrder.Descending); } catch (e) { /* ignore */ }
				}
			}));

			var oFilterItem = new MenuTextFieldItem({
				label: "Filter",
				icon: "sap-icon://filter",
				value: (oCol.getFilterValue ? (oCol.getFilterValue() || "") : ""),
				select: function () {
					var sVal = oFilterItem.getValue();
					try {
						oCol.setFilterValue(sVal);
						oTable.filter(oCol, sVal);
					} catch (e) { /* ignore */ }
				}
			});
			oMenu.addItem(oFilterItem);

			// 2) Dynamic suggestions (from EstadoFiltroSet)
			var oSugHeader = new MenuItem({
				text: "Sugerencias",
				startsSection: true,
				enabled: false
			});
			oMenu.addItem(oSugHeader);

			// Placeholder (will be replaced on beforeOpen)
			var oPlaceholder = new MenuItem({
				text: "(Sin sugerencias)",
				enabled: false
			});
			oMenu.addItem(oPlaceholder);

			var oClearItem = new MenuItem({
				text: "Quitar filtro",
				select: function () { that._applyColumnQuickFilter(oCol, null); }
			});
			oMenu.addItem(oClearItem);

			var oColumnsItem = new MenuItem({
				text: "Columns",
				startsSection: true,
				submenu: this._buildColumnsSubMenu(oTable)
			});
			oMenu.addItem(oColumnsItem);

			var fnRebuildSuggestions = function () {
				try {
					var aItems = oMenu.getItems() || [];
					var iHeader = aItems.indexOf(oSugHeader);
					var iClear = aItems.indexOf(oClearItem);
					if (iHeader < 0 || iClear < 0 || iClear <= iHeader) {
						return;
					}

					// Remove any existing suggestion items (between header and clear)
					for (var i = iClear - 1; i > iHeader; i--) {
						oMenu.removeItem(aItems[i]);
					}

					var oVM = that.getModel("worklistView");
					var aOpts = (oVM && oVM.getProperty) ? (oVM.getProperty(mCfg.optionsPath) || []) : [];
					var iInsertAt = (oMenu.getItems() || []).indexOf(oClearItem);

					if (!Array.isArray(aOpts) || aOpts.length === 0) {
						oMenu.insertItem(new MenuItem({ text: "(Sin sugerencias)", enabled: false }), iInsertAt);
						return;
					}

					aOpts.forEach(function (oOpt) {
						var sKey = (oOpt && oOpt.key != null) ? String(oOpt.key) : "";
						var sText = (oOpt && oOpt.text != null) ? String(oOpt.text) : sKey;
						if (!sKey) return;
						oMenu.insertItem(new MenuItem({
							text: sText,
							select: function () { that._applyColumnQuickFilter(oCol, sKey); }
						}), iInsertAt++);
					});
				} catch (e) {
					// ignore
				}
			};

			// Keep the filter text field + suggestions in sync whenever the menu opens
			if (oMenu.attachBeforeOpen) {
				oMenu.attachBeforeOpen(function () {
					try { oFilterItem.setValue(oCol.getFilterValue ? (oCol.getFilterValue() || "") : ""); } catch (e) { /* ignore */ }
					fnRebuildSuggestions();
				});
			}

			// Construir sugerencias una vez inmediatamente (para versiones donde Menu no tenga beforeOpen)
			fnRebuildSuggestions();

			oCol.setMenu(oMenu);
		},

		_isSunatApproved: function (sStatus) {
			// Requerimiento: comparación por DescEstd EXACTO (EstadoFiltroSet)
			var s = (sStatus == null) ? "" : String(sStatus);
			s = s.trim().toUpperCase();
			return s === "AP - APROBADO SUNAT";
		},

		_makeSunatApprovedFilter: function (bApproved) {
			// Importante: usar comparación EXACTA (sin fnTest) para evitar que un mismo registro
			// aparezca en Enviado y Reprocesado.
			return new Filter(
				"statusEnvioSunat",
				bApproved ? FilterOperator.EQ : FilterOperator.NE,
				"AP - Aprobado SUNAT"
			);
		},

        /* =========================================================== */
        /*  FilterBar handlers (real backend read)                     */
        /* =========================================================== */

        onFilterBarSearch: function () {
            var oView = this.getView();
            var oViewModel = this.getModel("worklistView");

            var sCentroVend = oViewModel.getProperty("/selectedCentroSum");
            var vCentroComp = oViewModel.getProperty("/selectedCentroRecep");
            var aCentroComp = Array.isArray(vCentroComp) ? vCentroComp : (vCentroComp ? [vCentroComp] : []);
            var sGrupoMat = oViewModel.getProperty("/selectedMaterial");

            var vEstadoReg = oViewModel.getProperty("/selectedEstadoReg");
            var aEstadoReg = Array.isArray(vEstadoReg) ? vEstadoReg : (vEstadoReg ? [vEstadoReg] : []);

            // Filtros por estado de proceso (EstadoFiltroSet)
            var vStatusFact = oViewModel.getProperty("/selectedStatusFact");
            var aStatusFact = Array.isArray(vStatusFact) ? vStatusFact : (vStatusFact ? [vStatusFact] : []);

            var vStatusSunat = oViewModel.getProperty("/selectedStatusSunat");
            var aStatusSunat = Array.isArray(vStatusSunat) ? vStatusSunat : (vStatusSunat ? [vStatusSunat] : []);

            var vStatusMiro = oViewModel.getProperty("/selectedStatusMiro");
            var aStatusMiro = Array.isArray(vStatusMiro) ? vStatusMiro : (vStatusMiro ? [vStatusMiro] : []);

            var oDateFrom = oView.byId("dateRangeEntrega").getDateValue();
            var oDateTo = oView.byId("dateRangeEntrega").getSecondDateValue();

            this._clearFilterValueStates();

            // We need these 4 values to build $filter (see Word)
            var aMissing = [];

            if (!sCentroVend) {
                aMissing.push("Centro vendedor");
                this.byId("selectCentroSum").setValueState("Error");
            }
            if (!aCentroComp.length) {
                aMissing.push("Centro comprador");
                this.byId("selectCentroRecep").setValueState("Error");
            }
            if (!oDateFrom || !oDateTo) {
                aMissing.push("Rango de fecha");
                this.byId("dateRangeEntrega").setValueState("Error");
            }
            if (!sGrupoMat) {
                aMissing.push("Grupo de material");
                this.byId("selectMaterial").setValueState("Error");
            }

            if (aMissing.length) {
                MessageBox.warning("Complete los filtros obligatorios: " + aMissing.join(", "));
                return;
            }

            // Normalizamos rango a [00:00:00 - 23:59:59] para que el filtro incluya ambos días completos
            var oFrom = new Date(oDateFrom.getFullYear(), oDateFrom.getMonth(), oDateFrom.getDate(), 0, 0, 0);
            var oTo = new Date(oDateTo.getFullYear(), oDateTo.getMonth(), oDateTo.getDate(), 23, 59, 59);

      var oCentroCompFilter = (aCentroComp.length === 1)
                ? new Filter("CentroComp", FilterOperator.EQ, aCentroComp[0])
                : new Filter({ filters: aCentroComp.map(function (k) { return new Filter("CentroComp", FilterOperator.EQ, k); }), and: false });

            var aFilters = [
                new Filter("CentroVend", FilterOperator.EQ, sCentroVend),
                oCentroCompFilter,
                new Filter("Extwg", FilterOperator.EQ, sGrupoMat),
                new Filter("Budat", FilterOperator.BT, oFrom, oTo)
            ];


            
            // Estado de Registro (opcional, múltiple)
            if (aEstadoReg.length) {
                var oEstadoRegFilter = (aEstadoReg.length === 1)
                    ? new Filter("EstadoReg", FilterOperator.EQ, aEstadoReg[0])
                    : new Filter({ filters: aEstadoReg.map(function (k) { return new Filter("EstadoReg", FilterOperator.EQ, k); }), and: false });
                aFilters.push(oEstadoRegFilter);
            }

            // Status Facturación (TipoProc=FACT) -> backend: StatusFact
            if (aStatusFact.length) {
                var oStatusFactFilter = (aStatusFact.length === 1)
                    ? new Filter("StatusFact", FilterOperator.EQ, aStatusFact[0])
                    : new Filter({ filters: aStatusFact.map(function (k) { return new Filter("StatusFact", FilterOperator.EQ, k); }), and: false });
                aFilters.push(oStatusFactFilter);
            }

            // Status Envío SUNAT (TipoProc=ENSN) -> backend: StatusEnvSunat
            if (aStatusSunat.length) {
                var oStatusSunatFilter = (aStatusSunat.length === 1)
                    ? new Filter("StatusEnvSunat", FilterOperator.EQ, aStatusSunat[0])
                    : new Filter({ filters: aStatusSunat.map(function (k) { return new Filter("StatusEnvSunat", FilterOperator.EQ, k); }), and: false });
                aFilters.push(oStatusSunatFilter);
            }

            // Status MIRO (TipoProc=MIRO) -> backend: StatusMiro
            if (aStatusMiro.length) {
                var oStatusMiroFilter = (aStatusMiro.length === 1)
                    ? new Filter("StatusMiro", FilterOperator.EQ, aStatusMiro[0])
                    : new Filter({ filters: aStatusMiro.map(function (k) { return new Filter("StatusMiro", FilterOperator.EQ, k); }), and: false });
                aFilters.push(oStatusMiroFilter);
            }

            this._loadDocumentoMonitor(aFilters);
        },

        onFilterBarReset: function () {
            var oViewModel = this.getModel("worklistView");
            oViewModel.setProperty("/selectedCentroSum", "");
            oViewModel.setProperty("/selectedCentroRecep", []);
            oViewModel.setProperty("/selectedMaterial", "");
            oViewModel.setProperty("/selectedEstadoReg", []);

            oViewModel.setProperty("/selectedStatusFact", []);
            oViewModel.setProperty("/selectedStatusSunat", []);
            oViewModel.setProperty("/selectedStatusMiro", []);
            oViewModel.setProperty("/selectedRowsCount", 0);

            // Reset controls
            var oDateRange = this.byId("dateRangeEntrega");
            if (oDateRange) {
                oDateRange.setDateValue(null);
                oDateRange.setSecondDateValue(null);
                oDateRange.setValue("");
            }
            this._clearFilterValueStates();

            // Clear table data
            this.getModel("pedidos").setData([]);
            this.byId("table").clearSelection();
        },

        onExport: function () {
			var aAll = this.getModel("pedidos").getData() || [];
			if (!Array.isArray(aAll) || aAll.length === 0) {
                MessageToast.show("No hay datos para exportar.");
                return;
            }

			// Nuevo comportamiento: si hay filas seleccionadas, exportar solo esas; si no, exportar todo
			var aSelected = this._getSelectedRowsData();
			var aData = (Array.isArray(aSelected) && aSelected.length) ? aSelected : aAll;

            var EdmType = exportLibrary.EdmType;

            var aColumns = [
                { label: "Pedido", property: "pedido", type: EdmType.String },
                { label: "Pos", property: "pos", type: EdmType.String },
                { label: "Material", property: "material", type: EdmType.String },
                { label: "Descripción", property: "descripcion", type: EdmType.String },
                { label: "Tipo Retención", property: "tipoRetencion", type: EdmType.String },
                { label: "Entrega", property: "entrega", type: EdmType.String },
                { label: "Centro Vend", property: "centroSum", type: EdmType.String },
                { label: "Centro Comp", property: "centroRecep", type: EdmType.String },
                { label: "Cant. Sal", property: "cantSal", type: EdmType.Number },
                { label: "Cant. Ent", property: "cantEnt", type: EdmType.Number },
                { label: "Dif. Cantidad", property: "difCantidadCalc", type: EdmType.Number },
                { label: "Importe Sal", property: "precioSal", type: EdmType.Number },
                { label: "Importe Ent", property: "precioEnt", type: EdmType.Number },
                                { label: "Status Fact.", property: "statusFacturacion", type: EdmType.String },
                { label: "Factura", property: "factura", type: EdmType.String },
                { label: "Status SUNAT", property: "statusEnvioSunat", type: EdmType.String },
                { label: "Referencia", property: "referencia", type: EdmType.String },
                { label: "Status MIRO", property: "statusMiro", type: EdmType.String },
                { label: "Doc MIRO", property: "docMiro", type: EdmType.String },
                { label: "Mensaje Últ. Evento", property: "mensajeUltimoEvento", type: EdmType.String }
            ];

			var oSheet = new Spreadsheet({
                workbook: { columns: aColumns },
                dataSource: aData,
                fileName: "Monitor_Intercompany.xlsx"
            });

            oSheet.build().finally(function () {
                oSheet.destroy();
            });
        },

        /* =========================================================== */
        /*  Other existing handlers (kept)                             */
        /* =========================================================== */

        onUpdateFinished: function () {
            this._updateWorklistTableTitleFromBinding();
        },

        onPress: function (oEvent) {
            this._showObject(oEvent.getSource());
        },

        onNavBack: function () {
            history.go(-1);
        },

        onSearch: function (oEvent) {
            if (oEvent.getParameters().refreshButtonPressed) {
                this.onRefresh();
                return;
            }

            var aTableSearchState = [];
            var sQuery = oEvent.getParameter("query");

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
        },

        onRefresh: function () {
            var oTable = this.byId("table");
            var oBinding = oTable.getBinding("rows");
            if (oBinding) {
                oBinding.refresh();
            }
        },

        _showObject: function (oItem) {
            // Placeholder
            var oCtx = oItem.getBindingContext("pedidos");
            var pedidoId = oCtx ? oCtx.getProperty("pedido") : null;
            if (pedidoId) {
                // You can implement navigation or a dialog here
                // this.getRouter().navTo("object", { objectId: pedidoId });
            }
        },

        _applySearch: function (aTableSearchState) {
            var oViewModel = this.getModel("worklistView");

            // Store search filters and combine with current tab (quick) filters
            this._aTableSearchState = Array.isArray(aTableSearchState) ? aTableSearchState : [];
            this._applyCombinedApplicationFilters(true);

            if (this._aTableSearchState.length !== 0) {
                oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("worklistNoDataWithSearchText"));
            } else {
                oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("tableNoDataText"));
            }
        },



        _applyCombinedApplicationFilters: function (bResetFirstRow) {
            var oTable = this.byId("table");
            if (!oTable) return;

            var oBinding = oTable.getBinding("rows");
            if (!oBinding) return;

            // Combine: current tab (quick) filters + search filters.
            // Column menu filters (header filters) remain as FilterType.Control and will not override this.
            var aAppFilters = [];
            if (Array.isArray(this._aQuickFilterState) && this._aQuickFilterState.length) {
                aAppFilters = aAppFilters.concat(this._aQuickFilterState);
            }
            if (Array.isArray(this._aTableSearchState) && this._aTableSearchState.length) {
                aAppFilters = aAppFilters.concat(this._aTableSearchState);
            }

            oBinding.filter(aAppFilters, FilterType.Application);

            // When the dataset shrinks due to filtering, keep scroll usable.
            if (bResetFirstRow && oTable.setFirstVisibleRow) {
                oTable.setFirstVisibleRow(0);
            }

            // Keep the "Cuentas (X)" counter always consistent.
            this._updateWorklistTableTitleFromBinding();
        },

        _updateWorklistTableTitleFromBinding: function () {
            var oTable = this.byId("table");
            var oViewModel = this.getModel("worklistView");
            if (!oTable || !oViewModel) return;

            var oBinding = oTable.getBinding("rows");
            var iTotalItems = oBinding ? oBinding.getLength() : 0;

            var sTitle;
            if (iTotalItems) {
                sTitle = this.getResourceBundle().getText("worklistTableTitleCount", [iTotalItems]);
                oViewModel.setProperty("/countAll", iTotalItems);
            } else {
                sTitle = this.getResourceBundle().getText("worklistTableTitle");
                oViewModel.setProperty("/countAll", 0);
            }
            oViewModel.setProperty("/worklistTableTitle", sTitle);
        },

        _onTableColumnFilter: function () {
            // Called when a column filter is applied/cleared (header menu).
            // We only ensure scroll + counter are consistent. We do NOT change any business logic.
            var oTable = this.byId("table");
            if (oTable && oTable.setFirstVisibleRow) {
                oTable.setFirstVisibleRow(0);
            }
            this._updateWorklistTableTitleFromBinding();
        },


                onQuickFilter: function (oEvent) {
            var oBinding = this._oTable.getBinding("rows"),
                sKey = oEvent.getParameter("selectedKey"),
                aFilters = [],
                oViewModel = this.getModel("worklistView");

            // Column visibility based on tab
            if (sKey === "inicial") {
                // En "Inicial" pueden convivir registros en distintos estados, así que mostramos todo
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
                oViewModel.setProperty("/colReferenciaVisible", true);
                oViewModel.setProperty("/colStatusMIROVisible", true);
                oViewModel.setProperty("/colDocMIROVisible", true);

                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");

                // Mostrar los 3 botones; se habilitan por selección + validación
                oViewModel.setProperty("/facturarBtnVisible", true);
                oViewModel.setProperty("/sunatBtnVisible", false);
                oViewModel.setProperty("/miroBtnVisible", false);
                oViewModel.setProperty("/reproBtnVisible", false);

                // Sin filtro en inicial (todos los estados)
                aFilters = [];
            } else if (sKey === "facturadoSAP") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", false);
                oViewModel.setProperty("/colReferenciaVisible", false);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/facturarBtnVisible", false);
oViewModel.setProperty("/sunatBtnVisible", true);
oViewModel.setProperty("/miroBtnVisible", false);
oViewModel.setProperty("/reproBtnVisible", false);
// Facturado SAP: con factura, SIN envío SUNAT (StatusEnvSunat vacío) y sin Doc MIRO
aFilters = [
    new Filter("factura", FilterOperator.NE, ""),
    new Filter("docMiro", FilterOperator.EQ, ""),
    new Filter("statusEnvioSunat", FilterOperator.EQ, "")
];
            } else if (sKey === "enviadoSUNAT") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
                oViewModel.setProperty("/colReferenciaVisible", true);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/facturarBtnVisible", false);
oViewModel.setProperty("/sunatBtnVisible", false);
oViewModel.setProperty("/miroBtnVisible", true);
oViewModel.setProperty("/reproBtnVisible", false);
// Enviado SUNAT: Status SUNAT = AP y aún sin Doc MIRO
aFilters = [
    new Filter("docMiro", FilterOperator.EQ, ""),
    this._makeSunatApprovedFilter(true)
];

            } else if (sKey === "reprocesadoSUNAT") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
                oViewModel.setProperty("/colReferenciaVisible", true);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/facturarBtnVisible", false);
oViewModel.setProperty("/sunatBtnVisible", false);
oViewModel.setProperty("/miroBtnVisible", false);
oViewModel.setProperty("/reproBtnVisible", true);
// Reprocesado: Status SUNAT != AP (y no vacío), aún sin Doc MIRO
aFilters = [
    new Filter("docMiro", FilterOperator.EQ, ""),
    new Filter("statusEnvioSunat", FilterOperator.NE, ""),
    this._makeSunatApprovedFilter(false)
];
            } else if (sKey === "registradoMIRO") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
                oViewModel.setProperty("/colReferenciaVisible", true);
                oViewModel.setProperty("/colStatusMIROVisible", true);
                oViewModel.setProperty("/colDocMIROVisible", true);
                oViewModel.setProperty("/tableSelectionMode", "None");
                oViewModel.setProperty("/facturarBtnVisible", false);
oViewModel.setProperty("/sunatBtnVisible", false);
oViewModel.setProperty("/miroBtnVisible", false);
oViewModel.setProperty("/reproBtnVisible", false);

                // Registrado MIRO: con Doc MIRO
                aFilters = [
                    new Filter("docMiro", FilterOperator.NE, "")
                ];
            }

// Reset selección al cambiar de pestaña
var oTable2 = this.byId("table");
if (oTable2 && oTable2.clearSelection) {
    oTable2.clearSelection();
}
oViewModel.setProperty("/selectedRowsCount", 0);
oViewModel.setProperty("/canFacturar", false);
oViewModel.setProperty("/canSunat", false);
oViewModel.setProperty("/canMiro", false);
oViewModel.setProperty("/canRepro", false);

// Keep tab (quick) filters separate from column filters.
this._aQuickFilterState = aFilters;
this._applyCombinedApplicationFilters(true);
        },

        onSelectionChange: function () {
            var oViewModel = this.getModel("worklistView");
            var aSelected = this._getSelectedRowsData();

            oViewModel.setProperty("/selectedRowsCount", aSelected.length);

            // Habilita el botón correcto según la pestaña actual + validaciones
            var oIconTabBar = this.byId("iconTabBar");
            var sKey = oIconTabBar ? oIconTabBar.getSelectedKey() : "inicial";
            var oFlags = this._getEligibilityFlagsForTab(sKey, aSelected);

            oViewModel.setProperty("/canFacturar", oFlags.canFacturar);
            oViewModel.setProperty("/canSunat", oFlags.canSunat);
            oViewModel.setProperty("/canMiro", oFlags.canMiro);
            oViewModel.setProperty("/canRepro", oFlags.canRepro);
        },

        /* =========================================================== */
/*  3 Procesos: FACTURAR / REG SUNAT / MIRO                     */
/* =========================================================== */

_getSelectedRowsData: function () {
    var oTable = this.byId("table");
    if (!oTable || !oTable.getSelectedIndices) return [];
    var aIdx = oTable.getSelectedIndices() || [];
    return aIdx.map(function (i) {
        var oCtx = oTable.getContextByIndex(i);
        return oCtx ? oCtx.getObject() : null;
    }).filter(Boolean);
},

_getEligibilityFlagsForTab: function (sKey, aSelectedRows) {
    // Devuelve "puede" según la pestaña actual y validaciones mínimas.
    var fnAny = function (a, fn) { return Array.isArray(a) && a.some(fn); };

    var canFact = false, canSunat = false, canMiro = false, canRepro = false;

    if (sKey === "inicial") {
        canFact = fnAny(aSelectedRows, this._isEligibleFacturar.bind(this));
        canSunat = fnAny(aSelectedRows, this._isEligibleSunat.bind(this));
        canMiro = fnAny(aSelectedRows, this._isEligibleMiro.bind(this));
    } else if (sKey === "facturadoSAP") {
        canSunat = fnAny(aSelectedRows, this._isEligibleSunat.bind(this));
    } else if (sKey === "enviadoSUNAT") {
        canMiro = fnAny(aSelectedRows, this._isEligibleMiro.bind(this));
    } else if (sKey === "reprocesadoSUNAT") {
        canRepro = fnAny(aSelectedRows, this._isEligibleRepro.bind(this));
    }
    return { canFacturar: canFact, canSunat: canSunat, canMiro: canMiro, canRepro: canRepro };
},

_isEligibleFacturar: function (row) {
    // Nuevo código de tolerancia:
    //  1 = Sin diferencia, 0 = Dentro de tolerancia, -1 = Fuera de tolerancia
    // Para facturar: dif. cantidad = 0, NO facturado, y tolerancia NO debe ser -1.
    var nDifCant = Number(row.difCantidadCalc || 0);
    var vTol = (row && row.estadoTol != null) ? row.estadoTol : "";
    var nTol = (vTol === "") ? 1 : Number(vTol);
    var bTolOk = (nTol === 1 || nTol === 0);
    var sFactura = (row.factura || "").trim();
    return !sFactura && nDifCant === 0 && bTolOk;
},

_isEligibleSunat: function (row) {
    // Solo si se ha facturado previamente
    var sFactura = (row.factura || "").trim();
    var sRef = (row.referencia || "").trim();
    var sStatusSunat = (row.statusEnvioSunat || "").trim();
    // Si ya tiene referencia o ya está AP, evitamos re-enviar desde este botón
    var bYaAprobado = this._isSunatApproved(sStatusSunat);
    return !!sFactura && !sRef && !bYaAprobado;
},

_isEligibleMiro: function (row) {
    // Solo si ya se facturó y SUNAT está aprobado (AP) y no tiene Doc MIRO
    var sFactura = (row.factura || "").trim();
    var sDocMiro = (row.docMiro || "").trim();
    var sStatusSunat = (row.statusEnvioSunat || "").trim();
    var bAP = this._isSunatApproved(sStatusSunat);
    // además: sin dif cantidad + tolerancia no debe ser -1
    var nDifCant = Number(row.difCantidadCalc || 0);
    var vTol = (row && row.estadoTol != null) ? row.estadoTol : "";
    var nTol = (vTol === "") ? 1 : Number(vTol);
    var bTolOk = (nTol === 1 || nTol === 0);
    return !!sFactura && !sDocMiro && bAP && nDifCant === 0 && bTolOk;
},


_isEligibleRepro: function (row) {
    // REPROCESO SUNAT (TipoProc = ERSN)
    // Requiere: Factura, NO Doc MIRO, Status SUNAT no vacío y distinto a AP
    var sFactura = (row.factura || "").trim();
    var sDocMiro = (row.docMiro || "").trim();
    var sStatusSunat = (row.statusEnvioSunat || "").trim();
    var bHasStatus = !!sStatusSunat;
    return !!sFactura && !sDocMiro && bHasStatus && !this._isSunatApproved(sStatusSunat);
},
_splitValidInvalid: function (sTipoProc, aRows) {
    var aValid = [];
    var aInvalid = [];

    var fnElig = null;
    if (sTipoProc === "FACT") fnElig = this._isEligibleFacturar.bind(this);
    if (sTipoProc === "ENSN") fnElig = this._isEligibleSunat.bind(this);
    if (sTipoProc === "MIRO") fnElig = this._isEligibleMiro.bind(this);
    if (sTipoProc === "ERSN") fnElig = this._isEligibleRepro.bind(this);

    (aRows || []).forEach(function (r) {
        if (!r) return;
        var ok = fnElig ? fnElig(r) : true;
        if (ok) {
            aValid.push(r);
        } else {
            aInvalid.push({
                pedido: r.pedido,
                pos: r.pos,
                material: r.material,
                descripcion: r.descripcion,
                motivo: this._getInvalidReason(sTipoProc, r)
            });
        }
    }.bind(this));

    return { valid: aValid, invalid: aInvalid };
},

_getInvalidReason: function (sTipoProc, r) {
    if (!r) return "Registro inválido";
    var nDifCant = Number(r.difCantidadCalc || 0);
	var vTol = (r && r.estadoTol != null) ? r.estadoTol : "";
	var nTol = (vTol === "") ? 1 : Number(vTol);
    var bTolOk = (nTol === 1 || nTol === 0);
    var sFactura = (r.factura || "").trim();
    var sRef = (r.referencia || "").trim();
    var sDocMiro = (r.docMiro || "").trim();
    var sStatusSunat = (r.statusEnvioSunat || "").trim();

    if (sTipoProc === "FACT") {
        if (sFactura) return "Ya tiene factura";
        if (nDifCant !== 0) return "Dif. cantidad ≠ 0";
        if (!bTolOk) return "Fuera de tolerancia";
        return "No cumple validaciones de facturación";
    }
    if (sTipoProc === "ENSN") {
        if (!sFactura) return "Sin factura";
        if (sRef) return "Ya tiene referencia";
        if (this._isSunatApproved(sStatusSunat)) return "SUNAT ya aprobado (AP)";
        return "No cumple validaciones de SUNAT";
    }
    if (sTipoProc === "MIRO") {
        if (!sFactura) return "Sin factura";
        if (sDocMiro) return "MIRO ya registrado";
        if (!this._isSunatApproved(sStatusSunat)) return "SUNAT no aprobado (AP)";
        if (nDifCant !== 0) return "Dif. cantidad ≠ 0";
        if (!bTolOk) return "Fuera de tolerancia";
        return "No cumple validaciones de MIRO";
    }

    if (sTipoProc === "ERSN") {
        if (!sFactura) return "Sin factura";
        if (sDocMiro) return "MIRO ya registrado";
        if (!sStatusSunat) return "Sin estado SUNAT";
        if (this._isSunatApproved(sStatusSunat)) return "SUNAT ya aprobado (AP)";
        return "No cumple validaciones de reproceso";
    }
    return "Registro inválido";
},

_confirmSkipInvalid: function (sTitulo, aInvalid, fnContinue) {
    // Muestra hasta 12 inválidos en el mensaje; el resto se resume.
    var iMax = 12;
    var aLines = (aInvalid || []).slice(0, iMax).map(function (x) {
        var sKey = [x.pedido, x.pos].filter(Boolean).join("-");
        return "• " + sKey + " / " + (x.material || "") + " — " + (x.motivo || "");
    });
    var sMore = (aInvalid && aInvalid.length > iMax) ? ("\n\n(+ " + (aInvalid.length - iMax) + " más)") : "";
    var sMsg = "Hay " + aInvalid.length + " registro(s) que NO cumplen validación y NO se enviarán.\n\n" + aLines.join("\n") + sMore + "\n\n¿Deseas continuar solo con los válidos?";

    MessageBox.confirm(sMsg, {
        title: sTitulo,
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: function (sAction) {
            if (sAction === MessageBox.Action.OK && typeof fnContinue === "function") {
                fnContinue();
            }
        }
    });
},

onFacturar: function () {
    // FACTURAR (TipoProc=FACT) con popup para periodo (MM/YYYY)
    var aSelected = this._getSelectedRowsData();
    if (!aSelected.length) {
        MessageToast.show("Seleccione al menos un registro.");
        return;
    }

    var oSplit = this._splitValidInvalid("FACT", aSelected);
    if (!oSplit.valid.length) {
        MessageBox.warning("Ningún registro cumple validación para FACTURAR (sin dif. cantidad y tolerancia válida: 🟢/🟡).");
        return;
    }

    var fnGo = function (sPeriodProc) {
        this._postEntregaProceso("FACT", sPeriodProc, oSplit.valid);
    }.bind(this);

    // Si hay inválidos, confirmamos continuar con válidos (antes de pedir periodo)
    if (oSplit.invalid.length) {
        this._confirmSkipInvalid("FACTURAR", oSplit.invalid, function () {
            this._promptPeriodProc(fnGo);
        }.bind(this));
    } else {
        this._promptPeriodProc(fnGo);
    }
},

_promptPeriodProc: function (fnOnOk) {
    // Reusa el patrón de popup existente, pero pide periodo mes/año.
    var that = this;

    if (this._oPeriodDialog) {
        this._oPeriodDialog.destroy();
    }

    var oDP = new sap.m.DatePicker("dpPeriodProc", {
        displayFormat: "MM/yyyy",
        valueFormat: "MM/yyyy",
        placeholder: "MM/YYYY",
        required: true
    });

    this._oPeriodDialog = new sap.m.Dialog({
        title: "Periodo de facturación",
        type: "Message",
        content: [
            new sap.m.Label({ text: "Ingrese el periodo (Mes/Año):", labelFor: oDP }),
            oDP
        ],
        beginButton: new sap.m.Button({
            text: "Aceptar",
            type: "Emphasized",
            press: function () {
                var sVal = oDP.getValue(); // ya viene MM/yyyy
                if (!sVal) {
                    oDP.setValueState("Error");
                    oDP.setValueStateText("Debe ingresar un periodo (MM/YYYY).");
                    return;
                }
                oDP.setValueState("None");
                that._oPeriodDialog.close();
                if (typeof fnOnOk === "function") {
                    // normalizamos a MM/YYYY (con slash) si el control devuelve MM/yyyy
                    var sNorm = sVal.replace("-", "/").replace(".", "/").replace(" ", "");
                    sNorm = sNorm.replace(" /", "/").replace("/ ", "/");
                    if (sNorm.indexOf("/") === -1 && sNorm.indexOf(" ") > -1) {
                        sNorm = sNorm.replace(" ", "/");
                    }
                    fnOnOk(sNorm);
                }
            }
        }),
        endButton: new sap.m.Button({
            text: "Cancelar",
            press: function () { that._oPeriodDialog.close(); }
        }),
        afterClose: function () {
            that._oPeriodDialog.destroy();
        }
    });

    this._oPeriodDialog.open();
},

onRegistrarSunat: function () {
    // REG SUNAT (TipoProc=ENSN)
    var aSelected = this._getSelectedRowsData();
    if (!aSelected.length) {
        MessageToast.show("Seleccione al menos un registro.");
        return;
    }

    var oSplit = this._splitValidInvalid("ENSN", aSelected);
    if (!oSplit.valid.length) {
        MessageBox.warning("Ningún registro cumple validación para REG SUNAT (requiere Factura).");
        return;
    }

    if (oSplit.invalid.length) {
        this._confirmSkipInvalid("REG SUNAT", oSplit.invalid, function () {
            this._postEntregaProceso("ENSN", "", oSplit.valid);
        }.bind(this));
    } else {
        this._postEntregaProceso("ENSN", "", oSplit.valid);
    }
},


onReprocesarSunat: function () {
    // REPROCESO SUNAT (TipoProc=ERSN)
    var aSelected = this._getSelectedRowsData();
    if (!aSelected.length) {
        MessageToast.show("Seleccione al menos un registro.");
        return;
    }

    var oSplit = this._splitValidInvalid("ERSN", aSelected);
    if (!oSplit.valid.length) {
        MessageBox.warning("Ningún registro cumple validación para REPROCESAR (requiere Status SUNAT no vacío y != AP).");
        return;
    }

    if (oSplit.invalid.length) {
        this._confirmSkipInvalid("REPROCESAR", oSplit.invalid, function () {
            this._postEntregaProceso("ERSN", "", oSplit.valid);
        }.bind(this));
    } else {
        this._postEntregaProceso("ERSN", "", oSplit.valid);
    }
},
onRegistrarMiro: function () {
    // Reg Factura MIRO (TipoProc=MIRO)
    var aSelected = this._getSelectedRowsData();
    if (!aSelected.length) {
        MessageToast.show("Seleccione al menos un registro.");
        return;
    }

    var oSplit = this._splitValidInvalid("MIRO", aSelected);
    if (!oSplit.valid.length) {
        MessageBox.warning("Ningún registro cumple validación para MIRO (requiere SUNAT aprobado AP).");
        return;
    }

    if (oSplit.invalid.length) {
        this._confirmSkipInvalid("Reg Factura MIRO", oSplit.invalid, function () {
            this._postEntregaProceso("MIRO", "", oSplit.valid);
        }.bind(this));
    } else {
        this._postEntregaProceso("MIRO", "", oSplit.valid);
    }
},

_postEntregaProceso: function (sTipoProc, sPeriodProc, aRows) {
    var oODataModel = this._getArticuloModel();
    var oTable = this.byId("table");
    var oViewModel = this.getModel("worklistView");

    var oPayload = this._buildEntregaPayload(sTipoProc, sPeriodProc, aRows);

    oTable.setBusy(true);

    oODataModel.create("/EntregaSet", oPayload, {
        success: function (oData) {
            oTable.setBusy(false);

            // Actualiza columnas localmente según respuesta del backend
            this._applyEntregaResponse(oData, sTipoProc);

            // Limpia selección + botones
            if (oTable && oTable.clearSelection) {
                oTable.clearSelection();
            }
            oViewModel.setProperty("/selectedRowsCount", 0);
            oViewModel.setProperty("/canFacturar", false);
            oViewModel.setProperty("/canSunat", false);
            oViewModel.setProperty("/canMiro", false);
oViewModel.setProperty("/canRepro", false);

            MessageToast.show("Proceso " + sTipoProc + " enviado. Revise mensajes/estado.");

            // Recargar datos y mover a la siguiente etapa para visualizar el nuevo estado
            this._refreshAfterProcess(sTipoProc, oData);
        }.bind(this),
        error: function (oError) {
            oTable.setBusy(false);
            MessageBox.error(this._formatODataError(oError, "Error al procesar (" + sTipoProc + ") en /EntregaSet."));
        }.bind(this)
    });
},

_refreshAfterProcess: function (sTipoProc, oData) {
    // No cambia lógica de negocio: solo refresca la data y navega a la pestaña donde corresponde ver el estado.
    try {
        var sNextKey = "inicial";

        if (sTipoProc === "FACT") {
            sNextKey = "facturadoSAP";
        } else if (sTipoProc === "MIRO") {
            sNextKey = "registradoMIRO";
		} else if (sTipoProc === "ENSN" || sTipoProc === "ERSN") {
            // Si el backend ya devuelve AP - Aprobado SUNAT -> Enviado; si no, Reprocesado
            var sAny = "";
            try {
                var aUpd = (oData && oData.EntregaListSet) ? (oData.EntregaListSet.results || oData.EntregaListSet || []) : [];
                if (Array.isArray(aUpd) && aUpd.length) {
                    sAny = aUpd[0].StatusEnvSunat || aUpd[0].statusEnvioSunat || "";
                }
            } catch (e1) { /* ignore */ }

            sNextKey = this._isSunatApproved(sAny) ? "enviadoSUNAT" : "reprocesadoSUNAT";
        }

        // Cambiar a la pestaña destino
        var oTab = this.byId("iconTabBar");
        if (oTab && oTab.setSelectedKey) {
            oTab.setSelectedKey(sNextKey);
        }

        // Re-consultar al backend con los mismos filtros seleccionados
        this.onFilterBarSearch();

        // Re-aplicar el filtro de la pestaña (client-side) tras recargar
        if (typeof this.onQuickFilter === "function") {
            this.onQuickFilter({
                getParameter: function (sName) {
                    return (sName === "selectedKey") ? sNextKey : null;
                }
            });
        }
    } catch (e) {
        // fallback: al menos recargar
        try { this.onFilterBarSearch(); } catch (e2) { /* ignore */ }
    }
},

_buildEntregaPayload: function (sTipoProc, sPeriodProc, aRows) {
    var oViewModel = this.getModel("worklistView");

    // Evita colisiones de IdItem entre ejecuciones (el backend devuelve EntregaListSet/EntregaRespuestaSet
    // identificado por IdItem). Dejamos idItem limpio antes de asignar IDs nuevos.
    try {
        var oPedidosModel = this.getModel("pedidos");
        var aAll = (oPedidosModel && oPedidosModel.getData) ? (oPedidosModel.getData() || []) : [];
        if (Array.isArray(aAll)) {
            aAll.forEach(function (r) { if (r) r.idItem = ""; });
        }
    } catch (e) { /* ignore */ }

    var sCentroVend = oViewModel.getProperty("/selectedCentroSum") || "";
    var vCentroCompSel = oViewModel.getProperty("/selectedCentroRecep");
    var sCentroCompFirst = Array.isArray(vCentroCompSel) ? (vCentroCompSel[0] || "") : (vCentroCompSel || "");
    var sExtwg = oViewModel.getProperty("/selectedMaterial") || "";

    var oHead = {
        Fepro: "",
        CentroVend: sCentroVend,
        Extwg: sExtwg,
        PeriodProc: sPeriodProc || "",
        TipoProc: sTipoProc
    };

    // IMPORTANTE:
    // IdItem en el servicio OData tiene restricciones de faceta (tipo/longitud/patrón).
    // No debemos enviar concatenados tipo "4500..._00030" porque el Gateway lo rechaza.
    // En la documentación, IdItem se usa solo como identificador de la asociación EntregaListSet
    // y para mapear mensajes en EntregaRespuestaSet.
    // Por eso generamos un IdItem corto y seguro (secuencial) por request.
    var aList = (aRows || []).map(function (r, i) {
        var sIdItem = String(i + 1); // "1", "2", ... (válido para Edm.Int32 o Edm.String corto)
        // Guardamos el idItem en la fila local para poder mapear la respuesta
        try { r.idItem = sIdItem; } catch (e) { /* ignore */ }
        return {
            IdItem: "",
            Ebeln: r.pedido || "",
            Ebelp: r.pos || "",
            DocSal643: r.docSal643 || "",
            Ejercicio643: r.ejercicio643 || "",
            Posicion643: r.posicion643 || "",
            Entrega: r.entrega || "",
            CentroComp: r.centroRecep || sCentroCompFirst,
            Factura: r.factura || "",
            StatusFact: r.statusFacturacion || "",
            Referencia: r.referencia || "",
            StatusEnvSunat: r.statusEnvioSunat || "",
            DocMiro: r.docMiro || "",
            StatusMiro: r.statusMiro || "",
            MsjUltEvento: r.mensajeUltimoEvento || "",
            EstadoReg: r.estadoReg || ""
        };
    });

    // Deep insert según estructura del Word (Head/List/Respuesta)
    return {
        Fepro: "",
        EntregaHeadSet: [oHead],
        EntregaListSet: aList,
        EntregaRespuestaSet: []
    };
},

_applyEntregaResponse: function (oData, sTipoProc) {
    // Aplica campos retornados por el backend a la tabla (JSONModel "pedidos")
    var oPedidosModel = this.getModel("pedidos");
    var aLocal = (oPedidosModel && oPedidosModel.getData) ? (oPedidosModel.getData() || []) : [];

    if (!Array.isArray(aLocal) || !aLocal.length) return;

    var mIndex = {};
    aLocal.forEach(function (r, idx) {
        var sId = r && (r.idItem || (String(r.pedido || "") + "_" + String(r.pos || "")));
        if (sId) mIndex[String(sId)] = idx;
    });

    var aUpd = [];
    if (oData && oData.EntregaListSet) {
        aUpd = oData.EntregaListSet.results || oData.EntregaListSet || [];
    }

    aUpd.forEach(function (u) {
        var sId = (u.IdItem != null) ? String(u.IdItem) : "";
        var idx = mIndex[sId];

        // Fallback: si el backend genera IdItem distinto al enviado (p.ej. '00001'),
        // mapeamos por clave de negocio EBELN+EBELP.
        if (idx == null) {
            var sEbeln = (u.Ebeln != null) ? String(u.Ebeln) : "";
            var sEbelp = (u.Ebelp != null) ? String(u.Ebelp) : "";
            if (sEbeln || sEbelp) {
                var sKey2 = sEbeln + "_" + sEbelp;
                idx = mIndex[sKey2];
            }
        }
        if (idx == null) return;

        var r = aLocal[idx];

        // Campos que se deben actualizar según TipoProc (pero el backend puede devolverlos todos)
        if (u.Factura != null) r.factura = String(u.Factura).trim();
        if (u.StatusFact != null) r.statusFacturacion = String(u.StatusFact).trim();
        if (u.Referencia != null) r.referencia = String(u.Referencia).trim();
        if (u.StatusEnvSunat != null) r.statusEnvioSunat = String(u.StatusEnvSunat).trim();
        if (u.DocMiro != null) r.docMiro = String(u.DocMiro);
        if (u.StatusMiro != null) r.statusMiro = String(u.StatusMiro).trim();
        if (u.MsjUltEvento != null) r.mensajeUltimoEvento = String(u.MsjUltEvento).trim();
        if (u.EstadoReg != null) r.estadoReg = String(u.EstadoReg).trim();
    });

    // Mensajes por item (EntregaRespuestaSet)
    var aResp = [];
    if (oData && oData.EntregaRespuestaSet) {
        aResp = oData.EntregaRespuestaSet.results || oData.EntregaRespuestaSet || [];
    }
    var mListByIdItem = {};
    (aUpd || []).forEach(function (u) {
        var k = (u && u.IdItem != null) ? String(u.IdItem) : "";
        if (k) { mListByIdItem[k] = u; }
    });
    this._pushProcesoMessages(aResp, mListByIdItem, sTipoProc);

    if (oPedidosModel && oPedidosModel.refresh) {
        oPedidosModel.refresh(true);
    }
},

_pushProcesoMessages: function (aResp, mListByIdItem, sTipoProc) {
            // Mensajes al MessageManager (MessagesIndicator) - más descriptivos
            var oMM = sap.ui.getCore().getMessageManager();
            var aMsgs = [];

            // Usamos el mismo processor que registramos en onInit
            var oProc = this._oMessageProcessor;
            if (!oProc) {
                oProc = new ControlMessageProcessor();
                Messaging.registerMessageProcessor(oProc);
                this._oMessageProcessor = oProc;
            }

            var mSeen = {};
            (aResp || []).forEach(function (r) {
                var sTipo = (r.TipoMsg == null) ? "" : String(r.TipoMsg).trim();
                var sMensaje = (r.Mensaje == null) ? "" : String(r.Mensaje).trim();
                var sId = (r.IdItem != null) ? String(r.IdItem) : "";

                // Tipo de mensaje
                var sMsgType = MessageType.Information;
                if (sTipo === "E") sMsgType = MessageType.Error;
                else if (sTipo === "W") sMsgType = MessageType.Warning;
                else if (sTipo === "S" || sTipo === "" || sTipo == null) sMsgType = MessageType.Success;

                // Contexto (pedido/pos/entrega) si viene en EntregaListSet
                var sCtx = "";
                if (mListByIdItem && sId && mListByIdItem[sId]) {
                    var u = mListByIdItem[sId];
                    var sEbeln = (u.Ebeln != null) ? String(u.Ebeln) : "";
                    var sEbelp = (u.Ebelp != null) ? String(u.Ebelp) : "";
                    var sEntrega = (u.Entrega != null) ? String(u.Entrega) : "";
                    sCtx = [sEbeln, sEbelp].filter(Boolean).join("/") || "";
                    if (sEntrega) {
                        sCtx = sCtx ? (sCtx + " | Entrega " + sEntrega) : ("Entrega " + sEntrega);
                    }
                } else if (sId) {
                    sCtx = "IdItem " + sId;
                }

                var sPrefix = (sTipoProc ? (sTipoProc + " - ") : "");
                var sTitle = sPrefix + (sCtx ? (sCtx + ": ") : "") + (sMensaje || (sMsgType === MessageType.Success ? "Proceso OK" : "Resultado"));

                // Evita duplicados
                if (mSeen[sTitle]) { return; }
                mSeen[sTitle] = true;

                aMsgs.push(new Message({
                    message: sTitle,
                    description: sMensaje || sTitle,
                    type: sMsgType,
                    processor: oProc
                }));
            });
            // Si el backend no devuelve mensajes, dejamos al menos un Success para que MessagesIndicator sea visible
            if (!aMsgs.length) {
                var sPfx = (sTipoProc ? (sTipoProc + " - ") : "");
                aMsgs.push(new Message({
                    message: sPfx + "Proceso ejecutado.",
                    description: sPfx + "Proceso ejecutado. Revise el estado actualizado en la tabla.",
                    type: MessageType.Success,
                    processor: oProc
                }));
            }

            // Limpia + agrega (evita superposición)
            try { oMM.removeAllMessages(); } catch (e) { /* ignore */ }
            try { oMM.addMessages(aMsgs); } catch (e2) { /* ignore */ }
        },

        onProcessSelected: function () {
            // Compatibilidad: el botón antiguo "Procesar Selección" equivale a Facturar
            this.onFacturar();
        },

        onMessagesButtonPress: function (oEvent) {
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