// aisCountries.js — MMSI Maritime Identification Digit (MID) → ISO 3166-1 alpha-3
// Source: ITU Maritime Mobile Access and Retrieval System (MARS)
export const MID_TO_COUNTRY = {
    201:'ALB',202:'AND',205:'BEL',207:'BGR',209:'CYP',210:'CYP',
    211:'DEU',218:'DEU',219:'DNK',220:'DNK',224:'ESP',225:'ESP',
    226:'FRA',227:'FRA',228:'FRA',230:'FIN',232:'GBR',233:'GBR',
    234:'GBR',235:'GBR',237:'GRC',238:'HRV',240:'GRC',241:'GRC',
    244:'NLD',245:'NLD',247:'ITA',250:'IRL',251:'ISL',255:'PRT',
    257:'NOR',258:'NOR',259:'NOR',261:'POL',265:'SWE',266:'SWE',
    269:'CHE',271:'TUR',272:'UKR',273:'RUS',275:'LVA',276:'EST',
    277:'LTU',303:'USA',308:'BHS',309:'BHS',316:'CAN',338:'USA',
    339:'JAM',351:'PAN',352:'PAN',353:'PAN',354:'PAN',355:'PAN',
    356:'PAN',357:'PAN',358:'PAN',366:'USA',367:'USA',368:'USA',
    369:'USA',370:'PAN',371:'PAN',372:'PAN',373:'PAN',374:'PAN',
    375:'VEN',403:'SAU',408:'BHR',410:'CHN',412:'CHN',413:'CHN',
    414:'CHN',416:'TWN',420:'IRN',422:'IRQ',423:'ISR',428:'JOR',
    431:'JPN',432:'JPN',434:'KWT',436:'LBN',438:'MYS',440:'KOR',
    441:'KOR',443:'OMN',445:'PAK',447:'PHL',450:'THA',451:'THA',
    453:'ARE',455:'VNM',457:'IND',459:'IND',461:'IDN',463:'IDN',
    468:'LKA',470:'SYR',471:'ARE',477:'HKG',478:'HKG',503:'AUS',
    506:'NZL',525:'IDN',563:'SGP',564:'SGP',565:'SGP',566:'SGP',
    601:'ZAF',605:'DZA',610:'CMR',616:'EGY',619:'ETH',625:'GHA',
    631:'GMB',633:'KEN',636:'LBR',637:'LBY',642:'MDG',655:'NAM',
    656:'NGA',660:'MAR',664:'SLE',670:'TUN',
};

// ── Callsign prefix → country (FALSE_FLAG check) ──────────────────────────────
// Source: ITU Table of International Call Sign Series (Radio Regulations,
// Appendix 42). This is a SEPARATE allocation from the MID table above — MID
// is assigned per MMSI block, callsign prefix is assigned per radio licence —
// so a genuine mismatch between the two is a real (if imperfect) signal that
// a vessel's broadcast identity doesn't match its claimed flag state.
//
// Coverage here is intentionally partial: it favors the classic
// flag-of-convenience registries (Panama, Liberia, Marshall Islands, Malta,
// Bahamas, Cyprus, Singapore, Hong Kong) plus a handful of major direct-flag
// states with unambiguous, non-overlapping prefix blocks. An unmapped
// callsign prefix simply skips the check — this can only under-report a
// mismatch, never manufacture a false positive from missing table coverage.
const CALLSIGN_PREFIX_TO_COUNTRY = {
    '3E':'PAN','3F':'PAN','H3':'PAN','HO':'PAN','HP':'PAN',
    'A8':'LBR','D5':'LBR','EL':'LBR',
    'V7':'MHL',
    '9H':'MLT',
    '5B':'CYP','C4':'CYP','P3':'CYP',
    'C6':'BHS',
    '9V':'SGP','S6':'SGP',
    'VR':'HKG',
    'BV':'TWN',
    'HL':'KOR','D7':'KOR','D8':'KOR','D9':'KOR',
    'LA':'NOR','LB':'NOR','LC':'NOR','LD':'NOR','LE':'NOR','LF':'NOR',
    'LG':'NOR','LH':'NOR','LI':'NOR','LJ':'NOR','LK':'NOR','LL':'NOR',
    'LM':'NOR','LN':'NOR',
    'SV':'GRC','SW':'GRC','SX':'GRC','SY':'GRC','SZ':'GRC','J4':'GRC',
    'OU':'DNK','OV':'DNK','OW':'DNK','OX':'DNK','OY':'DNK','OZ':'DNK',
    '9M':'MYS',
    'HS':'THA','E2':'THA',
    '3W':'VNM','XV':'VNM',
    'A6':'ARE',
    'HZ':'SAU','7Z':'SAU',
    'SU':'EGY',
    'ZS':'ZAF','ZR':'ZAF','ZT':'ZAF','ZU':'ZAF',
    'VT':'IND','VU':'IND','VW':'IND','AT':'IND','AU':'IND','AV':'IND','AW':'IND',
    'YB':'IDN','YC':'IDN','YD':'IDN','YE':'IDN','YF':'IDN','YG':'IDN','YH':'IDN',
    'PK':'IDN','PL':'IDN','PM':'IDN','PN':'IDN','PO':'IDN',
    'DU':'PHL','DV':'PHL','DW':'PHL','DX':'PHL','DY':'PHL','DZ':'PHL',
};

// callsign → ISO3, or null if unmapped/unknown. Matches on the first two
// characters (all entries above are exactly 2 chars, including digit-led
// prefixes like "9V" and "3E").
export function callsignToCountry(callsign) {
    if (!callsign) return null;
    const cs = String(callsign).trim().toUpperCase();
    if (cs.length < 2) return null;
    return CALLSIGN_PREFIX_TO_COUNTRY[cs.slice(0, 2)] || null;
}
