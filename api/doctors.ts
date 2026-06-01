import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logger } from "../server/_core/logger.js";
// v4: fast geocoding - only geocode user ZIP once, use lat/lng bounds on NPPES data

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 3959;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

async function getZipCoords(zip: string): Promise<{ lat: number; lng: number; state: string } | null> {
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${zip}`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data = await res.json();
    const place = data.places?.[0];
    if (!place) return null;
    return {
      lat: parseFloat(place.latitude),
      lng: parseFloat(place.longitude),
      state: place["state abbreviation"],
    };
  } catch (err) {
    logger.error({ err, zip }, "Failed to geocode ZIP");
    return null;
  }
}

// Geocode up to N zips with a per-request timeout and overall concurrency limit
async function batchGeocode(zips: string[]): Promise<Record<string, { lat: number; lng: number }>> {
  const map: Record<string, { lat: number; lng: number }> = {};
  // Process in chunks of 5 to avoid overwhelming the geocoder
  const CHUNK = 5;
  for (let i = 0; i < zips.length; i += CHUNK) {
    const chunk = zips.slice(i, i + CHUNK);
    await Promise.all(
      chunk.map(async (z) => {
        try {
          const coords = await getZipCoords(z);
          if (coords) map[z] = { lat: coords.lat, lng: coords.lng };
        } catch (err) {
          logger.error({ err, zip: z }, "Failed to batch geocode ZIP");
        }
      })
    );
  }
  return map;
}

function nameMatchesSearch(providerName: string, searchName: string): boolean {
  const search = searchName.toLowerCase().trim();
  const provider = providerName.toLowerCase();
  return search.split(/\s+/).every(part => provider.includes(part));
}

async function searchNPPES(name: string, state: string, limit = 200): Promise<any[]> {
  const parts = name.trim().split(/\s+/);
  const params = new URLSearchParams({
    version: "2.1",
    limit: String(limit),
    enumeration_type: "NPI-1",
  });
  if (parts.length >= 2) {
    params.set("first_name", parts[0] + "*");
    params.set("last_name", parts[parts.length - 1] + "*");
  } else {
    params.set("last_name", parts[0] + "*");
  }
  if (state) params.set("state", state);
  try {
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?${params}`, { signal: AbortSignal.timeout(8000) });
    const data = await res.json();
    return data.results || [];
  } catch (err) {
    logger.error({ err, name, state }, "NPPES search failed");
    return [];
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const name = (req.query.name as string || "").trim();
  const zip = (req.query.zip as string || "").trim();
  const radius = parseInt(req.query.radius as string || "25", 10);

  if (!name || name.length < 2) {
    return res.status(400).json({ error: "Name must be at least 2 characters" });
  }

  // Step 1: Geocode user ZIP (single call)
  let userCoords: { lat: number; lng: number; state: string } | null = null;
  if (zip) {
    userCoords = await getZipCoords(zip);
  }

  // Step 2: Search NPPES by name + state
  const results = await searchNPPES(name, userCoords?.state || "");

  // Step 3: Map to our format
  const doctors = results.map((r: any) => {
    const basic = r.basic || {};
    const addr = r.addresses?.find((a: any) => a.address_purpose === "LOCATION") || r.addresses?.[0] || {};
    const taxonomy = r.taxonomies?.find((t: any) => t.primary) || r.taxonomies?.[0] || {};
    const fullName = basic.credential
      ? `${basic.last_name}, ${basic.first_name} ${basic.credential}`
      : `${basic.last_name}, ${basic.first_name}`;
    const fullAddress = [addr.address_1, addr.address_2, addr.city, addr.state, addr.postal_code?.substring(0, 5)]
      .filter(Boolean).join(", ");
    return {
      npi: r.number,
      name: fullName.toUpperCase(),
      specialty: taxonomy.desc || "Healthcare Provider",
      address: fullAddress,
      phone: addr.telephone_number || "",
      city: addr.city || "",
      state: addr.state || "",
      zip: addr.postal_code?.substring(0, 5) || "",
      lat: null as number | null,
      lng: null as number | null,
      distance: null as number | null,
    };
  });

  // Step 4: Filter by name
  const nameFiltered = doctors.filter((d: any) => nameMatchesSearch(d.name, name));

  // Step 5: If zip provided, geocode result zips and filter by radius
  if (userCoords && zip) {
    const uniqueZips = [...new Set(nameFiltered.map((d: any) => d.zip).filter(Boolean))] as string[];
    // Only geocode up to 20 unique zips to stay within time limits
    const zipsToGeocode = uniqueZips.slice(0, 20);
    const zipMap = await batchGeocode(zipsToGeocode);
    zipMap[zip] = { lat: userCoords.lat, lng: userCoords.lng };

    for (const doc of nameFiltered) {
      if (doc.zip && zipMap[doc.zip]) {
        const c = zipMap[doc.zip];
        doc.lat = c.lat;
        doc.lng = c.lng;
        doc.distance = Math.round(haversine(userCoords.lat, userCoords.lng, c.lat, c.lng) * 10) / 10;
      }
    }

    const filtered = nameFiltered
      .filter((d: any) => d.distance !== null && d.distance <= radius)
      .sort((a: any, b: any) => (a.distance || 999) - (b.distance || 999));

    return res.json({ total: filtered.length, zip, radius, doctors: filtered });
  }

  return res.json({ total: nameFiltered.length, zip: null, radius: null, doctors: nameFiltered.slice(0, 20) });
}
