#!/usr/bin/env python3
"""Génère des PDF de factures/devis français réalistes pour tester l'extraction."""
import os
import sys

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    PageBreak, SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle,
)

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pdf")
os.makedirs(OUT, exist_ok=True)

styles = getSampleStyleSheet()


def euro(v):
    s = f"{v:,.2f}".replace(",", " ").replace(".", ",")
    return f"{s} €"


def build(filename, *, kind, number, date, client_name, client_addr, lines,
          vat=20.0, due=None, seller="GLACES DU LITTORAL", client_label=True):
    path = os.path.join(OUT, filename)
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm)
    story = []
    title = "FACTURE" if kind == "invoice" else "DEVIS"
    story.append(Paragraph(f"<b>{seller}</b>", styles["Heading2"]))
    story.append(Paragraph("12 rue des Sables — 44600 Saint-Nazaire<br/>"
                           "SIRET 812 345 678 00019 — TVA FR40812345678",
                           styles["Normal"]))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph(f"<b>{title} N° {number}</b>", styles["Heading1"]))
    story.append(Paragraph(f"Date : {date}", styles["Normal"]))
    if due:
        story.append(Paragraph(f"Date d'échéance : {due}", styles["Normal"]))
    story.append(Spacer(1, 5 * mm))
    if client_label:
        story.append(Paragraph("<b>Client :</b>", styles["Normal"]))
    story.append(Paragraph(f"{client_name}<br/>{client_addr}", styles["Normal"]))
    story.append(Spacer(1, 8 * mm))

    data = [["Réf.", "Désignation", "Qté", "Unité", "P.U. HT", "Total HT"]]
    total_ht = 0.0
    for ref, label, qty, unit, pu in lines:
        tot = qty * pu
        total_ht += tot
        data.append([ref, label, f"{qty:g}".replace(".", ","), unit, euro(pu), euro(tot)])

    t = Table(data, colWidths=[24 * mm, 66 * mm, 16 * mm, 18 * mm, 26 * mm, 26 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("ALIGN", (2, 1), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]))
    story.append(t)
    story.append(Spacer(1, 6 * mm))

    tva = round(total_ht * vat / 100.0, 2)
    ttc = round(total_ht + tva, 2)
    totals = [
        ["Total HT", euro(total_ht)],
        [f"TVA {vat:g}%".replace(".", ","), euro(tva)],
        ["Total TTC", euro(ttc)],
    ]
    tt = Table(totals, colWidths=[40 * mm, 34 * mm], hAlign="RIGHT")
    tt.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("ALIGN", (1, 0), (1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("BACKGROUND", (0, 2), (-1, 2), colors.HexColor("#f2f2f2")),
    ]))
    story.append(tt)
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("Conditions de règlement : 30 jours date de facture.", styles["Normal"]))
    doc.build(story)
    print("écrit", path, "| HT", total_ht, "TVA", tva, "TTC", ttc)
    return {"file": filename, "ht": round(total_ht, 2), "tva": tva, "ttc": ttc}


def build_two_pages(filename):
    """Facture sur deux pages avec en-tête vendeur réimprimé et pied de page
    légal — le gabarit qui faisait lire l'adresse comme des articles."""
    path = os.path.join(OUT, filename)
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm)
    story = []

    def entete(avec_client):
        rows = [["EXEMPLE SARL", "FACTURE"],
                ["27 RUE DU TEST", "N° : FA-2026-2PAGES"],
                ["PA DE BRAIS", "Date : 03/07/2026"],
                ["44600 - ST NAZAIRE CEDEX 4460", ""]]
        if avec_client:
            # Le bloc client n'apparaît que sur la première page, comme sur les
            # vraies factures.
            rows += [["", "Facturé à :"],
                     ["", "GLACIER DE LA PLAGE"],
                     ["", "5 BOULEVARD DES DUNES"],
                     ["", "44500 LA BAULE"]]
        t = Table(rows, colWidths=[85 * mm, 85 * mm])
        t.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 9),
                               ("VALIGN", (0, 0), (-1, -1), "TOP")]))
        return t

    def tableau(lignes):
        data = [["Libellé", "Qté", "Unité", "PU HT", "Montant HT", "TVA"]] + lignes
        t = Table(data, colWidths=[62 * mm, 16 * mm, 16 * mm, 22 * mm, 26 * mm, 16 * mm])
        t.setStyle(TableStyle([
            ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
            ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
            ("FONTSIZE", (0, 0), (-1, -1), 8),
        ]))
        return t

    pied = ("EXEMPLE SARL - 27 RUE DU TEST PA DE BRAIS 44600 ST NAZAIRE - "
            "IBAN FR7610000000000000000000000 - Code NAF (APE) 4669C - "
            "RCS : NC - Siret : 00000000000000 - N° TVA FR00000000000")

    story.append(entete(True))
    story.append(Spacer(1, 8 * mm))
    story.append(tableau([["Mix vanille poche 4,5 kg", "20,00", "pc", euro(17.20), euro(344.00), "5,50%"],
                          ["Mix fraise poche 4,5 kg", "10,00", "pc", euro(17.80), euro(178.00), "5,50%"]]))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph(pied, styles["Normal"]))
    story.append(Paragraph("Page 1 de 2", styles["Normal"]))
    story.append(PageBreak())

    # Page 2 : en-tête réimprimé, puis la suite du tableau.
    story.append(entete(False))
    story.append(Spacer(1, 8 * mm))
    story.append(tableau([["Cornets x120", "3,00", "carton", euro(49.00), euro(147.00), "5,50%"]]))
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Total HT   669,00 €", styles["Normal"]))
    story.append(Paragraph("TVA 5,50%   36,80 €", styles["Normal"]))
    story.append(Paragraph("Total TTC   705,80 €", styles["Normal"]))
    story.append(Paragraph(pied, styles["Normal"]))
    story.append(Paragraph("Page 2 de 2", styles["Normal"]))

    doc.build(story)
    print("écrit", path, "| HT attendu 669,00 sur 3 lignes, TTC 705,80")


def build_watermarked(filename):
    """Facture brouillon tamponnée : « BROUILLON » en diagonale par-dessus le
    tableau, et « DUPLICATA » en gros à l'horizontale. Aucun des deux ne doit
    se retrouver dans les libellés ni dans les montants."""
    path = os.path.join(OUT, filename)

    def filigrane(canvas, doc):
        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 62)
        canvas.setFillGray(0.85)
        # En diagonale, en travers du tableau.
        canvas.translate(105 * mm, 150 * mm)
        canvas.rotate(38)
        canvas.drawCentredString(0, 0, "BROUILLON")
        canvas.restoreState()

        canvas.saveState()
        canvas.setFont("Helvetica-Bold", 44)
        canvas.setFillGray(0.85)
        canvas.drawCentredString(105 * mm, 200 * mm, "DUPLICATA")
        canvas.restoreState()

    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm)
    story = [
        Paragraph("<b>EXEMPLE SARL</b>", styles["Heading2"]),
        Paragraph("27 rue du Test — 44600 Saint-Nazaire", styles["Normal"]),
        Spacer(1, 6 * mm),
        Paragraph("<b>FACTURE N° FA-2026-0301</b>", styles["Heading1"]),
        Paragraph("Date : 12/06/2026", styles["Normal"]),
        Spacer(1, 4 * mm),
        Paragraph("<b>Client :</b>", styles["Normal"]),
        Paragraph("GLACIER DE LA PLAGE<br/>5 boulevard des Dunes — 44500 La Baule",
                  styles["Normal"]),
        Spacer(1, 8 * mm),
    ]

    lines = [("Mix vanille poche 4,5 kg", 4, "poche", 17.20, 68.80),
             ("Gobelet carton 120 ml (x100)", 6, "carton", 9.50, 57.00)]
    data = [["Désignation", "Qté", "Unité", "P.U. HT", "Total HT"]]
    for label, qty, unit, pu, tot in lines:
        data.append([label, f"{qty:g}", unit, euro(pu), euro(tot)])
    t = Table(data, colWidths=[70 * mm, 16 * mm, 20 * mm, 26 * mm, 30 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
    ]))
    story.append(t)
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Total HT   125,80 €", styles["Normal"]))
    story.append(Paragraph("TVA 5,50%   6,92 €", styles["Normal"]))
    story.append(Paragraph("Total TTC   132,72 €", styles["Normal"]))

    doc.build(story, onFirstPage=filigrane, onLaterPages=filigrane)
    print("écrit", path, "| HT attendu 125,80 malgré le filigrane")


if __name__ == "__main__":
    build_two_pages("FA-2026-2PAGES.pdf")
    build_watermarked("FA-2026-FILIGRANE.pdf")
    build("FA-2026-0142.pdf", kind="invoice", number="FA-2026-0142",
          date="14/03/2026", due="13/04/2026",
          client_name="LE COMPTOIR DES GLACES SARL",
          client_addr="8 avenue de la Plage — 44500 La Baule",
          lines=[
              ("CUP-100", "Coupelle carton 100 ml (x50)", 12, "carton", 8.90),
              ("SPO-BOI", "Cuillère bois 95 mm (x100)", 6, "carton", 4.20),
              ("BAC-5L", "Bac inox 5 L", 4, "pièce", 23.50),
              ("SAC-KR", "Sachet kraft imprimé (x250)", 3, "carton", 31.00),
          ])

    build("FA-2026-0143.pdf", kind="invoice", number="FA-2026-0143",
          date="22/03/2026", due="21/04/2026",
          client_name="Restaurant La Dune",
          client_addr="3 boulevard Océan — 44420 Piriac-sur-Mer",
          lines=[
              ("CUP-100", "Coupelle carton 100 ml (x50)", 5, "carton", 8.90),
              ("CON-STD", "Cornet gaufré standard (x120)", 8, "carton", 12.40),
          ])

    build("FA-2026-0210.pdf", kind="invoice", number="FA-2026-0210",
          date="18/05/2026", client_label=False,
          client_name="Restaurant La Dune",
          client_addr="3 boulevard Océan — 44420 Piriac-sur-Mer",
          lines=[
              ("CON-STD", "Cornet gaufré standard (x120)", 4, "carton", 12.40),
              ("SER-BLA", "Serviette blanche 30x30 (x500)", 2, "carton", 14.80),
          ])

    build("DE-2026-0031.pdf", kind="quote", number="DE-2026-0031",
          date="2 avril 2026",
          client_name="Mairie de Pornichet",
          client_addr="Place du Marché — 44380 Pornichet",
          lines=[
              ("PRE-EVT", "Prestation événementielle — chariot glaces", 1, "forfait", 850.00),
              ("CUP-100", "Coupelle carton 100 ml (x50)", 20, "carton", 8.90),
          ])


def build_two_column(filename, *, number, date, client_ref, client_name, client_street,
                      client_city, client_email, lines, vat=20.0):
    """Reproduit le gabarit « vendeur à gauche / client à droite, mêmes lignes »
    de certains logiciels de facturation, avec un tableau récapitulatif de TVA
    en bas de page — la mise en forme qui a révélé les bugs d'extraction."""
    path = os.path.join(OUT, filename)
    doc = SimpleDocTemplate(path, pagesize=A4,
                            leftMargin=18 * mm, rightMargin=18 * mm,
                            topMargin=18 * mm, bottomMargin=18 * mm)
    story = []

    # En-tête à deux colonnes : vendeur (gauche) / document + client (droite).
    header = Table(
        [
            ["EXEMPLE SARL", "FACTURE"],
            ["1 rue du Test", f"N° : {number}"],
            ["44000 - ville CEDEX", f"Date : {date}"],
            ["France", ""],
            ["Siret : 00000000000000", f"N° client : {client_ref}"],
            ["", client_name],
            ["Tél. : 00 00 00 00 00", client_street],
            ["Email : contact@exemple.fr", client_city],
            ["", f"Email : {client_email}"],
        ],
        colWidths=[85 * mm, 85 * mm],
    )
    header.setStyle(TableStyle([
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
    ]))
    story.append(header)
    story.append(Spacer(1, 8 * mm))

    data = [["Libellé", "Qté", "Unité", "PU HT", "Rem.", "Montant HT", "TVA"]]
    total_ht = 0.0
    for label, qty, unit, pu, rem_pct in lines:
        montant = round(qty * pu * (1 - rem_pct / 100), 2)
        total_ht += montant
        data.append([label, f"{qty:g}".replace(".", ","), unit, euro(pu),
                     f"{rem_pct:g}".replace(".", ",") + "%", euro(montant),
                     f"{vat:g}".replace(".", ",") + "%"])
    t = Table(data, colWidths=[45 * mm, 12 * mm, 18 * mm, 22 * mm, 14 * mm, 26 * mm, 15 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#eeeeee")),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#999999")),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
    ]))
    story.append(t)
    story.append(Spacer(1, 6 * mm))

    tva = round(total_ht * vat / 100.0, 2)
    ttc = round(total_ht + tva, 2)

    # Tableau récapitulatif : « Détail de la TVA » suivi d'un en-tête
    # « Code | Base HT | Taux | Montant » — c'est ce bloc qui, sur une mise en
    # page à deux colonnes, se confondait avec un vrai total.
    recap = Table(
        [
            ["Détail de la TVA", "Total HT", euro(total_ht)],
            ["Code", "Base HT", "Taux", "Montant", "TVA", euro(tva)],
            ["Normale", euro(total_ht), f"{vat:g}%", euro(tva), "Total TTC", euro(ttc)],
        ],
        colWidths=[28 * mm, 22 * mm, 15 * mm, 22 * mm, 20 * mm, 22 * mm],
    )
    recap.setStyle(TableStyle([("FONTSIZE", (0, 0), (-1, -1), 8)]))
    story.append(recap)
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("Règlement Virement", styles["Normal"]))
    story.append(Paragraph("Coordonnées bancaires", styles["Normal"]))
    story.append(Paragraph("IBAN FR7610000000000000000000000", styles["Normal"]))
    story.append(Paragraph(f"Le montant total s'élève à {ttc} euros", styles["Normal"]))

    doc.build(story)
    print("écrit", path, "| HT", round(total_ht, 2), "TVA", tva, "TTC", ttc)


if __name__ == "__main__":
    build_two_column(
        "FA-2026-DEUXCOL.pdf", number="FA-2026-DEUXCOL", date="15/03/2026",
        client_ref="CL9001", client_name="LES GLACES DU PORT",
        client_street="12 QUAI DU COMMERCE", client_city="56100 LORIENT",
        client_email="contact@glacesduport.fr",
        lines=[
            ("Bac gastro inox GN 1/3", 2, "Pièce", 45.00, 0),
            ("Cuillère bois 95mm (x100)", 3, "Carton", 4.20, 50),
        ],
    )
