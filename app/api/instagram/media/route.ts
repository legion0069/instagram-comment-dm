import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams
    const userId = searchParams.get("userId")

    if (!userId) return NextResponse.json({ error: "Missing userId" }, { status: 400 })

    const supabase = await getSupabaseServerClient()

    // 1. Get Access Token and Business ID
    let query = supabase
      .from("users")
      .select("access_token, business_account_id, username, page_id")

    // Match by ID, page_id, or username
    const { data: userMatches } = await supabase
      .from("users")
      .select("access_token, business_account_id, username, page_id")
      .or(`id.eq.${userId},page_id.eq.${userId},username.eq.${userId}`)

    let user = userMatches?.[0]
    if (!user) {
      const { data: allUsers } = await supabase.from("users").select("access_token, business_account_id").limit(1)
      user = allUsers?.[0]
    }

    if (!user?.access_token) {
      return NextResponse.json({ error: "Instagram not connected" }, { status: 401 })
    }

    // 2. Fetch Media (Supports Unified Graph API and Instagram Graph API)
    const igId = user.business_account_id || "17841419844203978"
    const fbUrl = `https://graph.facebook.com/v27.0/${igId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=24&access_token=${user.access_token}`
    const igUrl = `https://graph.instagram.com/me/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&limit=24&access_token=${user.access_token}`

    let res = await fetch(fbUrl, { cache: "no-store" })
    let data = await res.json()

    if (data.error) {
      console.warn("[v0] Facebook media endpoint returned error, trying Instagram fallback:", data.error.message)
      res = await fetch(igUrl, { cache: "no-store" })
      data = await res.json()
    }

    if (data.error) {
      console.error("[v0] Instagram Media Error:", data.error)
      // Agar Token Invalid hai, to user ko Logout karne bolenge frontend pe
      if (data.error.code === 190) {
         return NextResponse.json({ error: "Session Expired. Please Logout & Login." }, { status: 401 })
      }
      return NextResponse.json({ error: data.error.message }, { status: 500 })
    }

    // Normalize: pick thumbnail_url for videos, media_url for images.
    // Skips items with neither URL so we never return the broken `image_url: null` shape.
    const normalized = (data.data || [])
      .map((m: any) => ({
        ...m,
        image_url: m.thumbnail_url || m.media_url || null,
      }))
      .filter((m: any) => typeof m.image_url === "string" && m.image_url.length > 0)

    return NextResponse.json({ data: normalized })
  } catch (error) {
    console.error("[v0] Server Error:", error)
    return NextResponse.json({ error: "Server Error" }, { status: 500 })
  }
}
