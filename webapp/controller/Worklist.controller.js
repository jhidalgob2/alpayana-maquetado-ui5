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

            var oViewModel = new JSONModel({
                worklistTableTitle: this.getResourceBundle().getText("worklistTableTitle"),
                shareOnJamTitle: this.getResourceBundle().getText("worklistTitle"),
                shareSendEmailSubject: this.getResourceBundle().getText("shareSendEmailWorklistSubject"),
                shareSendEmailMessage: this.getResourceBundle().getText("shareSendEmailWorklistMessage", [location.href]),
                tableNoDataText: this.getResourceBundle().getText("tableNoDataText"),
                tableBusyDelay: 0,

                // Column visibility flags by "Estado"
                colStatusFacturacionVisible: false,
                colFacturaVisible: false,
                colStatusEnvioSunatVisible: false,
                colReferenciaVisible: false,
                colStatusMIROVisible: false,
                colDocMIROVisible: false,

                // Filter options (filled from OData)
                centroSumOptions: [],
                centroRecepOptions: [],
                materialOptions: [],

                // Selected filters
                selectedCentroSum: "",
                selectedCentroRecep: "",
                selectedMaterial: "",

                // Table / toolbar state
                selectedRowsCount: 0,
                tableSelectionMode: "MultiToggle",
                processBtnVisible: true
            });
            this.setModel(oViewModel, "worklistView");

            // Pedidos model (table datasource) - we keep JSONModel to avoid touching the XML view/styles.
            this.getView().setModel(new JSONModel([]), "pedidos");

            // Set message model for MessagesIndicator
            var oMessageManager = sap.ui.getCore().getMessageManager();
            this.getView().setModel(oMessageManager.getMessageModel(), "message");

            // Load filter options from the real service (articuloModel -> articuloService in manifest)
            this._loadFilterOptions();

            // Keep original busy delay after first data update
            var iOriginalBusyDelay = oTable.getBusyIndicatorDelay();
            oTable.attachEventOnce("rowsUpdated", function () {
                oViewModel.setProperty("/tableBusyDelay", iOriginalBusyDelay);
            });

            // Dummy messages (kept as-is; later you can replace with real backend feedback)
            var oMessageProcessor = new ControlMessageProcessor();
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
                })
            ]);
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
            oViewModel.setProperty("/selectedCentroRecep", "000000000001");
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
                statusFacturacion: o.StatusFact || "",
                factura: o.Factura || "",
                statusEnvioSunat: o.StatusEnvSunat || "",
                referencia: o.Referencia || "",
                statusMiro: o.StatusMiro || "",
                docMiro: (o.DocMiro == null) ? "" : String(o.DocMiro),
                mensajeUltimoEvento: o.MsjUltEvento || "",

                // Extra fields from the entity (not necessarily visible yet)
                docSal643: (o.DocSal643 == null) ? "" : String(o.DocSal643),
                docEnt101: (o.DocEnt101 == null) ? "" : String(o.DocEnt101),
                estadoTol: this._toNumber(o.EstadoTol),
                estadoReg: o.EstadoReg || "",
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

            [oCentroVend, oCentroComp, oGrupoMat, oDateRange].forEach(function (oCtrl) {
                if (oCtrl && oCtrl.setValueState) {
                    oCtrl.setValueState("None");
                    oCtrl.setValueStateText("");
                }
            });
        },

        /* =========================================================== */
        /*  FilterBar handlers (real backend read)                     */
        /* =========================================================== */

        onFilterBarSearch: function () {
            var oView = this.getView();
            var oViewModel = this.getModel("worklistView");

            var sCentroVend = oViewModel.getProperty("/selectedCentroSum");
            var sCentroComp = oViewModel.getProperty("/selectedCentroRecep");
            var sGrupoMat = oViewModel.getProperty("/selectedMaterial");

            var oDateFrom = oView.byId("dateRangeEntrega").getDateValue();
            var oDateTo = oView.byId("dateRangeEntrega").getSecondDateValue();

            this._clearFilterValueStates();

            // We need these 4 values to build $filter (see Word)
            var aMissing = [];

            if (!sCentroVend) {
                aMissing.push("Centro vendedor");
                this.byId("selectCentroSum").setValueState("Error");
            }
            if (!sCentroComp) {
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

      var aFilters = [
                new Filter("CentroVend", FilterOperator.EQ, sCentroVend),
                new Filter("CentroComp", FilterOperator.EQ, sCentroComp),
                new Filter("Extwg", FilterOperator.EQ, sGrupoMat),
                new Filter("Budat", FilterOperator.BT, oFrom, oTo)
            ];


            this._loadDocumentoMonitor(aFilters);
        },

        onFilterBarReset: function () {
            var oViewModel = this.getModel("worklistView");
            oViewModel.setProperty("/selectedCentroSum", "");
            oViewModel.setProperty("/selectedCentroRecep", "");
            oViewModel.setProperty("/selectedMaterial", "");
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
            var aData = this.getModel("pedidos").getData() || [];
            if (!Array.isArray(aData) || aData.length === 0) {
                MessageToast.show("No hay datos para exportar.");
                return;
            }

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
                { label: "Dif. Importe", property: "difImporteCalc", type: EdmType.Number },
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

        onUpdateFinished: function (oEvent) {
            var sTitle,
                oTable = oEvent.getSource(),
                oViewModel = this.getModel("worklistView"),
                oBinding = oTable.getBinding("rows"),
                iTotalItems = oBinding ? oBinding.getLength() : 0;

            // For client-side JSONModel, getLength() is final.
            if (iTotalItems) {
                sTitle = this.getResourceBundle().getText("worklistTableTitleCount", [iTotalItems]);
                oViewModel.setProperty("/countAll", iTotalItems);
            } else {
                sTitle = this.getResourceBundle().getText("worklistTableTitle");
            }
            this.getModel("worklistView").setProperty("/worklistTableTitle", sTitle);
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
            var oTable = this.byId("table"),
                oViewModel = this.getModel("worklistView");

            oTable.getBinding("rows").filter(aTableSearchState, FilterType.Application);

            if (aTableSearchState.length !== 0) {
                oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("worklistNoDataWithSearchText"));
            } else {
                oViewModel.setProperty("/tableNoDataText", this.getResourceBundle().getText("tableNoDataText"));
            }
        },

        onQuickFilter: function (oEvent) {
            var oBinding = this._oTable.getBinding("rows"),
                sKey = oEvent.getParameter("selectedKey"),
                aFilters = [],
                oViewModel = this.getModel("worklistView");

            // Column visibility based on tab
            if (sKey === "inicial") {
                oViewModel.setProperty("/colStatusFacturacionVisible", false);
                oViewModel.setProperty("/colFacturaVisible", false);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", false);
                oViewModel.setProperty("/colReferenciaVisible", false);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/processBtnVisible", true);

                // "Inicial": still no factura
                aFilters = [
                    new Filter("factura", FilterOperator.EQ, "")
                ];
            } else if (sKey === "facturadoSAP") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", false);
                oViewModel.setProperty("/colReferenciaVisible", false);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/processBtnVisible", true);

                // Facturado SAP: con factura y sin referencia
                aFilters = [
                    new Filter("factura", FilterOperator.NE, ""),
                    new Filter("referencia", FilterOperator.EQ, "")
                ];
            } else if (sKey === "enviadoSUNAT") {
                oViewModel.setProperty("/colStatusFacturacionVisible", true);
                oViewModel.setProperty("/colFacturaVisible", true);
                oViewModel.setProperty("/colStatusEnvioSunatVisible", true);
                oViewModel.setProperty("/colReferenciaVisible", true);
                oViewModel.setProperty("/colStatusMIROVisible", false);
                oViewModel.setProperty("/colDocMIROVisible", false);
                oViewModel.setProperty("/tableSelectionMode", "MultiToggle");
                oViewModel.setProperty("/processBtnVisible", true);

                // Enviado SUNAT: con referencia y aún sin Doc MIRO
                aFilters = [
                    new Filter("referencia", FilterOperator.NE, ""),
                    new Filter("docMiro", FilterOperator.EQ, "")
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

                // Registrado MIRO: con Doc MIRO
                aFilters = [
                    new Filter("docMiro", FilterOperator.NE, "")
                ];
            }

            oBinding.filter(aFilters);
        },

        onSelectionChange: function () {
            var oTable = this.byId("table");
            var aSelectedIndices = (oTable && oTable.getSelectedIndices) ? oTable.getSelectedIndices() : [];
            var iCount = Array.isArray(aSelectedIndices) ? aSelectedIndices.length : 0;
            this.getModel("worklistView").setProperty("/selectedRowsCount", iCount);
        },

        onProcessSelected: function () {
            var oTable = this.byId("table");
            var aSelectedIndices = (oTable && oTable.getSelectedIndices) ? oTable.getSelectedIndices() : [];
            var aSelectedData = (aSelectedIndices || []).map(function (i) {
                var oCtx = oTable.getContextByIndex(i);
                return oCtx ? oCtx.getObject() : null;
            }).filter(Boolean);

            if (!aSelectedData.length) {
                MessageToast.show("No se han seleccionado registros para procesar.");
                return;
            }

            var aMismatches = aSelectedData.filter(function (row) { return row._mismatch; });
            var that = this;

            function processValidRows(aValidRows, selectedDate) {
                // TODO (FUERA DE ALCANCE ACTUAL): llamada real al backend para procesamiento
                var msg = aValidRows.length + " filas válidas serán procesadas";
                if (selectedDate) {
                    msg += " con fecha " + selectedDate;
                }
                MessageToast.show(msg);
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
                            var mm = String(oDate.getMonth() + 1).padStart(2, "0");
                            var dd = String(oDate.getDate()).padStart(2, "0");
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
                    title: "Filas con diferencias",
                    contentWidth: "600px",
                    type: "Message",
                    content: [
                        new sap.m.Text({
                            text: "Las siguientes filas tienen diferencias y no serán enviadas para su procesamiento.\n¿Desea continuar con las filas válidas o cancelar la acción?",
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

                            var oIconTabBar = that.byId("iconTabBar");
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

                var oMismatchModel = new JSONModel({ mismatches: aMismatches });
                this._oMismatchDialog.setModel(oMismatchModel);
                this._oMismatchDialog.open();
            } else {
                // No mismatches
                var oIconTabBar2 = this.byId("iconTabBar");
                var sKey2 = oIconTabBar2 ? oIconTabBar2.getSelectedKey() : null;
                if (sKey2 === "inicial") {
                    promptForDateAndProcess(aSelectedData);
                } else {
                    processValidRows(aSelectedData);
                }
            }
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