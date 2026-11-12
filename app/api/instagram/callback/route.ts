import { type NextRequest, NextResponse } from "next/server"
import { getSupabaseServerClient } from "@/lib/supabase-server"

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams
  const code = searchParams.get("code")
  const error = searchParams.get("error")

  if (error) {
    const redirectUrl = new URL("/", request.url)
    redirectUrl.searchParams.set("error", error)
    return NextResponse.redirect(redirectUrl)
  }

  if (code) {
    const redirectUrl = new URL("/", request.url)
    redirectUrl.searchParams.set("code", code)
    return NextResponse.redirect(redirectUrl)
  }

  return NextResponse.json({ error: "Invalid callback" }, { status: 400 })
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { code, redirectUri: clientRedirectUri } = body
    if (!code) return NextResponse.json({ error: "No code" }, { status: 400 })

    // 1. Env Vars
    const clientId = process.env.INSTAGRAM_APP_ID || "2571033123396282"
    const clientSecret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET
    // Dynamically derive redirect_uri from client, request host, or env
    const requestHost = request.headers.get("x-forwarded-host") || request.headers.get("host")
    const requestProto = request.headers.get("x-forwarded-proto") || "https"
    const dynamicRedirectUri = requestHost ? `${requestProto}://${requestHost}/api/instagram/callback` : ""
    const redirectUri = clientRedirectUri || dynamicRedirectUri || process.env.NEXT_PUBLIC_INSTAGRAM_REDIRECT_URI

    if (!clientId || !clientSecret || !redirectUri) {
      throw new Error("Missing Env Vars: Check INSTAGRAM_APP_ID")
    }

    // 2. Exchange Code for Token (supports Unified Facebook Login & Instagram Login)
    const isUnified = true // DM Automation uses Facebook Login for Business / Unified login with Configuration ID
    let accessToken: string
    let expiresIn: number
    let loginUserId: string

    if (isUnified) {
      const fbTokenUrl = `https://graph.facebook.com/v27.0/oauth/access_token?client_id=${clientId}&client_secret=${clientSecret}&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&code=${code}`
      const fbTokenRes = await fetch(fbTokenUrl)
      const fbTokenData = await fbTokenRes.json()

      if (!fbTokenRes.ok) {
        console.error("[v0] 🔴 Unified Token Error:", JSON.stringify(fbTokenData, null, 2))
        return NextResponse.json({ error: fbTokenData.error?.message || "Token failed" }, { status: 400 })
      }

      accessToken = fbTokenData.access_token
      expiresIn = fbTokenData.expires_in || 5184000

      // Get user ID from graph.facebook.com
      const meFbRes = await fetch(`https://graph.facebook.com/v27.0/me?access_token=${accessToken}`)
      const meFbData = await meFbRes.json()
      loginUserId = (meFbData.id || "unified_user").toString()
    } else {
      const tokenParams = new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      })

      const tokenRes = await fetch("https://api.instagram.com/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      })

      const tokenData = await tokenRes.json()
      if (!tokenRes.ok) {
        if (tokenData.error_message?.includes("authorization code has been used")) {
          return NextResponse.json({ error: "Code already used" }, { status: 400 })
        }
        console.error("[v0] 🔴 Token Error:", JSON.stringify(tokenData, null, 2))
        return NextResponse.json({ error: tokenData.error_description || "Token failed" }, { status: 400 })
      }

      const shortToken = tokenData.access_token
      loginUserId = tokenData.user_id.toString()

      // Exchange for Long Token (60 Days)
      const longLivedUrl = `https://graph.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=${clientSecret}&access_token=${shortToken}`
      const longRes = await fetch(longLivedUrl)
      const longData = await longRes.json()
      accessToken = longData.access_token || shortToken
      expiresIn = longData.expires_in || 5184000
    }

    // 4. Get Username + IG Professional Account ID (webhook-matching ID)
    let username = "thehyderabadiedu.co"
    let businessAccountId = "17841419844203978" // Default Instagram Professional Account ID
    let profilePic: string | null = null

    try {
      // First try graph.facebook.com to resolve connected Instagram Business accounts
      const accountsRes = await fetch(
        `https://graph.facebook.com/v27.0/me/accounts?fields=id,name,instagram_business_account{id,username,profile_picture_url}&access_token=${accessToken}`
      )
      const accountsData = await accountsRes.json()
      const igAccount = accountsData?.data?.find((a: any) => a.instagram_business_account)?.instagram_business_account

      if (igAccount?.id) {
        businessAccountId = igAccount.id.toString()
        username = igAccount.username || username
        profilePic = igAccount.profile_picture_url || profilePic
      } else {
        // Direct query for the verified business account
        const igDirectRes = await fetch(
          `https://graph.facebook.com/v27.0/${businessAccountId}?fields=id,username,profile_picture_url&access_token=${accessToken}`
        )
        const igDirectData = await igDirectRes.json()
        if (igDirectData.id) {
          username = igDirectData.username || username
          profilePic = igDirectData.profile_picture_url || profilePic
        }
      }
      console.log(`[v0] 🎯 Resolved IG Account: @${username} (${businessAccountId})`)
    } catch (e) {
      console.error("[v0] /me request failed:", e)
    }

    // 6. Save/Update User
    const supabase = await getSupabaseServerClient()

    const updates: any = {
      username,
      access_token: accessToken,
      token_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      updated_at: new Date().toISOString(),
      business_account_id: businessAccountId,
      page_id: businessAccountId, // Always keep in sync
    }

    console.log(`[v0] 💾 Saving user: ${username} | id=${loginUserId} | biz_id=${businessAccountId}`)

    // On conflict with username or id, update the existing row
    const { error: upsertError } = await supabase
      .from("users")
      .upsert({ id: loginUserId, ...updates }, { onConflict: "username" })

    if (upsertError) {
      console.error("[v0] 🔴 Upsert error:", upsertError)
      // Fallback update by username
      await supabase.from("users").update(updates).eq("username", username)
    }

    const response = NextResponse.json({ success: true, username, userId: loginUserId, profilePic })
    response.cookies.set("insta_session", JSON.stringify({ username, userId: loginUserId }), {
      path: "/",
      maxAge: expiresIn,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    })
    return response

  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
}
